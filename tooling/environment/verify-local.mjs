import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const local = path.join(root, "tooling", "environment", "local.mjs");
const validate = path.join(root, "tooling", "environment", "validate.mjs");
const temp = path.join(root, ".local", `wp0006-verify-${process.pid}`);
const secret = path.join(temp, "postgres-password");
const envFile = path.join(temp, "environment.env");
const logFile = path.join(temp, "supervisor.log");
const projectName = "bop-rms-wp0006-verify";
const ports = { api: 53001, customerPwa: 53003, merchantWeb: 53002, postgres: 55433 };
const healthyStatusTimeoutMs = 180_000;
let supervisor;
let logHandle;

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function compose(...args) {
  return run(
    "docker",
    [
      "compose",
      "--project-directory",
      root,
      "--project-name",
      projectName,
      "--env-file",
      envFile,
      "--file",
      path.join(root, "compose.yaml"),
      ...args,
    ],
    { capture: false },
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function invoke(file, args, options = {}) {
  return spawnSync(options.node ?? process.execPath, [file, ...args], {
    cwd: root,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
}

function assertFailure(result, expected) {
  assert(result.status !== 0, `Expected failure containing: ${expected}`);
  assert(
    `${result.stdout}\n${result.stderr}`.includes(expected),
    `Failure did not contain expected text: ${expected}`,
  );
}

async function waitForStatus() {
  const deadline = Date.now() + healthyStatusTimeoutMs;
  let last = "no status result";
  while (Date.now() < deadline) {
    if (supervisor.exitCode !== null) {
      const supervisorLog = fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").split(/\r?\n/u).slice(-40).join("\n")
        : "log unavailable";
      throw new Error(
        `Supervisor exited before healthy status: ${supervisor.exitCode}\n${supervisorLog}`,
      );
    }
    const result = invoke(local, ["status", "--env-file", envFile]);
    last = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0) return JSON.parse(result.stdout);
    await delay(500);
  }
  const supervisorLog = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").split(/\r?\n/u).slice(-40).join("\n")
    : "log unavailable";
  throw new Error(
    `Local environment did not become healthy within ${healthyStatusTimeoutMs}ms: ${last}\n${supervisorLog}`,
  );
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}

async function cleanup() {
  try {
    if (supervisor && supervisor.exitCode === null) supervisor.kill("SIGTERM");
    const deadline = Date.now() + 15_000;
    while (supervisor && supervisor.exitCode === null && Date.now() < deadline) await delay(100);
    if (supervisor && supervisor.exitCode === null) supervisor.kill("SIGKILL");
  } catch {
    // Best-effort process cleanup continues with Compose cleanup.
  }
  try {
    if (fs.existsSync(envFile)) compose("down", "--volumes", "--remove-orphans");
  } catch {
    // Preserve the original verification failure.
  }
  if (logHandle) {
    fs.closeSync(logHandle);
    logHandle = undefined;
  }
  fs.rmSync(temp, { force: true, recursive: true });
}

process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));
process.once("SIGTERM", () => void cleanup().finally(() => process.exit(143)));

try {
  fs.mkdirSync(temp, { mode: 0o700, recursive: true });
  fs.writeFileSync(secret, `wp0006-synthetic-${process.pid}`, { mode: 0o600 });
  fs.writeFileSync(
    envFile,
    [
      `BOP_RMS_COMPOSE_PROJECT=${projectName}`,
      "BOP_RMS_ENVIRONMENT=test",
      "BOP_RMS_POSTGRES_HOST=127.0.0.1",
      `BOP_RMS_POSTGRES_PASSWORD_FILE=${path.relative(root, secret)}`,
      `BOP_RMS_POSTGRES_PORT=${ports.postgres}`,
      "BOP_RMS_POSTGRES_DB=bop_rms_wp0006_verify",
      "BOP_RMS_POSTGRES_USER=bop_rms_wp0006_verify",
      "BOP_RMS_POSTGRES_SSL_MODE=disable",
      `BOP_RMS_API_PORT=${ports.api}`,
      `BOP_RMS_MERCHANT_WEB_PORT=${ports.merchantWeb}`,
      `BOP_RMS_CUSTOMER_PWA_PORT=${ports.customerPwa}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const valid = invoke(validate, ["--env-file", envFile, "--check-ports"]);
  assert(valid.status === 0, `Valid environment was rejected: ${valid.stderr}`);
  const validOutput = JSON.parse(valid.stdout);
  assert(validOutput.status === "valid", "Validator did not return valid status");
  assert(
    !valid.stdout.includes(`wp0006-synthetic-${process.pid}`),
    "Validator disclosed the secret",
  );

  const unsafeSecret = path.join(temp, "unsafe-password");
  fs.writeFileSync(unsafeSecret, "synthetic", { mode: 0o644 });
  const unsafeEnv = path.join(temp, "unsafe.env");
  fs.copyFileSync(envFile, unsafeEnv);
  fs.writeFileSync(
    unsafeEnv,
    fs
      .readFileSync(unsafeEnv, "utf8")
      .replace(path.relative(root, secret), path.relative(root, unsafeSecret)),
  );
  assertFailure(
    invoke(validate, ["--env-file", unsafeEnv]),
    "PostgreSQL secret file mode must be 0600",
  );

  const duplicateEnv = path.join(temp, "duplicate-port.env");
  fs.writeFileSync(
    duplicateEnv,
    fs
      .readFileSync(envFile, "utf8")
      .replace(
        `BOP_RMS_CUSTOMER_PWA_PORT=${ports.customerPwa}`,
        `BOP_RMS_CUSTOMER_PWA_PORT=${ports.api}`,
      ),
  );
  assertFailure(
    invoke(validate, ["--env-file", duplicateEnv]),
    "Configured localhost ports must be unique",
  );

  if (
    fs.existsSync("/usr/bin/node") &&
    fs.realpathSync("/usr/bin/node") !== fs.realpathSync(process.execPath)
  )
    assertFailure(
      invoke(validate, ["--env-file", envFile], { node: "/usr/bin/node" }),
      "Node.js must be v24.18.0",
    );

  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen({ host: "127.0.0.1", port: ports.api }, resolve);
  });
  try {
    assertFailure(
      invoke(validate, ["--env-file", envFile, "--check-ports"]),
      `BOP_RMS_API_PORT port ${ports.api} is already in use`,
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }

  logHandle = fs.openSync(logFile, "w", 0o600);
  supervisor = spawn(process.execPath, [local, "start", "--env-file", envFile], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      BOP_RMS_WP0006_SENTINEL: "synthetic-environment-isolation-probe",
    },
    stdio: ["ignore", logHandle, logHandle],
  });
  const status = await waitForStatus();
  assert(status.supervisor === "running", "Supervisor was not running");
  assert(status.worker === "running", "Worker was not running");
  assert(status.postgres === "running", "PostgreSQL was not running");
  const runtime = JSON.parse(
    fs.readFileSync(path.join(root, ".local", "environment", `${projectName}.json`), "utf8"),
  );
  for (const [name, pid] of Object.entries(runtime.childPids)) {
    const childEnvironment = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    assert(
      !childEnvironment.includes("BOP_RMS_WP0006_SENTINEL="),
      `${name} inherited a BOP_RMS_* environment variable`,
    );
  }
  assert(
    Object.values(status.endpoints).every((value) => value === "healthy"),
    "One or more HTTP skeletons were unhealthy",
  );

  const health = await globalThis.fetch(`http://127.0.0.1:${ports.api}/health`);
  assert(health.status === 200, "API health did not return 200");
  const ready = await globalThis.fetch(`http://127.0.0.1:${ports.api}/ready`);
  const readiness = await ready.json();
  assert(ready.status === 503, "API readiness must remain 503");
  assert(readiness.status === "not_ready", "API readiness must remain not_ready");
  assert(
    readiness.dependencies?.database?.status === "not_configured",
    "API database readiness must remain not_configured",
  );

  const stopped = invoke(local, ["stop", "--env-file", envFile]);
  assert(stopped.status === 0, `Stop command failed: ${stopped.stderr}`);
  const deadline = Date.now() + 20_000;
  while (supervisor.exitCode === null && Date.now() < deadline) await delay(100);
  assert(supervisor.exitCode === 0, `Supervisor exit was not clean: ${supervisor.exitCode}`);
  for (const port of Object.values(ports))
    assert(await portIsFree(port), `Verification port ${port} remained occupied`);

  compose("down", "--volumes", "--remove-orphans");
  const resources = run("docker", [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
  ]).trim();
  assert(!resources, "Verification container remained after cleanup");
  const networks = run("docker", [
    "network",
    "ls",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
  ]).trim();
  assert(!networks, "Verification network remained after cleanup");
  const volumes = run("docker", [
    "volume",
    "ls",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
  ]).trim();
  assert(!volumes, "Verification volume remained after cleanup");
  const logs = fs.readFileSync(logFile, "utf8");
  assert(!logs.includes(`wp0006-synthetic-${process.pid}`), "Supervisor logs disclosed the secret");
  assert(
    !fs.existsSync(path.join(root, ".local", "environment", `${projectName}.json`)),
    "Runtime state remained after stop",
  );
  process.stdout.write("WP-0006 root environment verification passed.\n");
} finally {
  await cleanup();
}
