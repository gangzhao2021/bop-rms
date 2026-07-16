import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadEnvironment, runtimeFile } from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [command, ...args] = process.argv.slice(2);
let envFile = ".env";
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== "--env-file" || !args[index + 1])
    throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  envFile = args[index + 1];
  index += 1;
}
if (!new Set(["start", "status", "stop"]).has(command))
  throw new Error("Usage: local.mjs <start|status|stop> [--env-file <path>]");

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return (
      commandLine.includes("tooling/environment/local.mjs") &&
      commandLine.split("\0").includes("start")
    );
  } catch {
    return false;
  }
}

function readRuntime(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function composeArgs(config, ...extra) {
  return [
    "compose",
    "--project-directory",
    config.root,
    "--project-name",
    config.projectName,
    "--env-file",
    config.envFile,
    "--file",
    path.join(config.root, "compose.yaml"),
    ...extra,
  ];
}

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    ...options,
  });
}

async function waitForHttp(url, child, expectedStatus = 200, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`${child.name} exited during startup`);
    try {
      const response = await globalThis.fetch(url, {
        signal: globalThis.AbortSignal.timeout(2_000),
      });
      if (response.status === expectedStatus) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request failed";
    }
    await delay(500);
  }
  throw new Error(`${url} did not reach HTTP ${expectedStatus}: ${lastError}`);
}

const applicationEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("BOP_RMS_")),
);

function spawnService(name, executable, args, environment = {}) {
  const child = spawn(executable, args, {
    cwd: root,
    detached: true,
    env: { ...applicationEnvironment, ...environment },
    stdio: "inherit",
  });
  child.name = name;
  return child;
}

async function terminateGroup(child, signal) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function start(config) {
  const stateFile = runtimeFile(config);
  const prior = readRuntime(stateFile);
  if (prior && processAlive(prior.supervisorPid))
    throw new Error(`Local environment is already supervised by PID ${prior.supervisorPid}`);
  if (prior) fs.rmSync(stateFile, { force: true });

  run(config.toolchain.executables.pnpm, ["build"]);
  run(
    config.toolchain.executables.docker,
    composeArgs(config, "up", "--detach", "--wait", "postgres"),
  );

  fs.mkdirSync(path.dirname(stateFile), { mode: 0o700, recursive: true });
  const children = [];
  let stopping = false;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  const shutdown = async (reason, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Stopping local environment (${reason})...\n`);
    for (const child of children) await terminateGroup(child, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (children.some((child) => child.exitCode === null) && Date.now() < deadline)
      await delay(100);
    for (const child of children) await terminateGroup(child, "SIGKILL");
    try {
      run(config.toolchain.executables.docker, composeArgs(config, "stop", "postgres"));
    } finally {
      fs.rmSync(stateFile, { force: true });
      process.exitCode = exitCode;
      resolveStopped();
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGHUP", () => void shutdown("SIGHUP"));

  try {
    const api = spawnService("API", process.execPath, ["apps/api/dist/server.js"], {
      PORT: String(config.ports.api),
    });
    const worker = spawnService("Worker", process.execPath, ["apps/worker/dist/index.js"]);
    const merchantWeb = spawnService("Merchant Web", config.toolchain.executables.pnpm, [
      "--filter",
      "@bop-rms/merchant-web",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(config.ports.merchantWeb),
      "--strictPort",
    ]);
    const customerPwa = spawnService("Customer PWA", config.toolchain.executables.pnpm, [
      "--filter",
      "@bop-rms/customer-pwa",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(config.ports.customerPwa),
      "--strictPort",
    ]);
    children.push(api, worker, merchantWeb, customerPwa);
    for (const child of children)
      child.once("exit", (code, signal) => {
        if (!stopping) void shutdown(`${child.name} exited (${signal ?? code ?? "unknown"})`, 1);
      });
    for (const child of children)
      child.once("error", (error) => {
        if (!stopping) void shutdown(`${child.name} failed to start (${error.message})`, 1);
      });

    fs.writeFileSync(
      stateFile,
      `${JSON.stringify(
        {
          childPids: Object.fromEntries(children.map((child) => [child.name, child.pid])),
          envFile: path.relative(config.root, config.envFile),
          ports: config.ports,
          projectName: config.projectName,
          startedAt: new Date().toISOString(),
          supervisorPid: process.pid,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    await Promise.all([
      waitForHttp(`http://127.0.0.1:${config.ports.api}/health`, api),
      waitForHttp(`http://127.0.0.1:${config.ports.merchantWeb}/`, merchantWeb),
      waitForHttp(`http://127.0.0.1:${config.ports.customerPwa}/`, customerPwa),
      delay(1_000).then(() => {
        if (worker.exitCode !== null) throw new Error("Worker exited during startup");
      }),
    ]);
    const ready = await waitForHttp(`http://127.0.0.1:${config.ports.api}/ready`, api, 503);
    const body = await ready.json();
    if (body.status !== "not_ready" || body.dependencies?.database?.status !== "not_configured")
      throw new Error("API readiness must remain not_ready with database not_configured");
    process.stdout.write(
      `${JSON.stringify({ ports: config.ports, projectName: config.projectName, status: "running" }, null, 2)}\n`,
    );
    await stopped;
  } catch (error) {
    await shutdown("startup failure", 1);
    throw error;
  }
}

async function status(config) {
  const state = readRuntime(runtimeFile(config));
  const stateMatches =
    state?.projectName === config.projectName &&
    JSON.stringify(state?.ports) === JSON.stringify(config.ports);
  const supervisor = stateMatches && processAlive(state.supervisorPid) ? "running" : "stopped";
  let worker = "stopped";
  if (supervisor === "running" && Number.isInteger(state.childPids?.Worker)) {
    try {
      const workerCommand = fs.readFileSync(`/proc/${state.childPids.Worker}/cmdline`, "utf8");
      if (workerCommand.includes("apps/worker/dist/index.js")) worker = "running";
    } catch {
      worker = "stopped";
    }
  }
  let postgres = "stopped";
  try {
    const services = run(
      config.toolchain.executables.docker,
      composeArgs(config, "ps", "--status", "running", "--services"),
      { capture: true },
    );
    if (services.split(/\r?\n/u).includes("postgres")) postgres = "running";
  } catch {
    postgres = "unavailable";
  }
  const endpoints = {};
  for (const [name, port] of [
    ["api", config.ports.api],
    ["merchantWeb", config.ports.merchantWeb],
    ["customerPwa", config.ports.customerPwa],
  ]) {
    try {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${port}/${name === "api" ? "health" : ""}`,
        {
          signal: globalThis.AbortSignal.timeout(2_000),
        },
      );
      endpoints[name] = response.ok ? "healthy" : `http_${response.status}`;
    } catch {
      endpoints[name] = "stopped";
    }
  }
  const result = { endpoints, postgres, projectName: config.projectName, supervisor, worker };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    supervisor !== "running" ||
    worker !== "running" ||
    postgres !== "running" ||
    Object.values(endpoints).some((value) => value !== "healthy")
  )
    process.exitCode = 1;
}

async function stop(config) {
  const file = runtimeFile(config);
  const state = readRuntime(file);
  if (state && processAlive(state.supervisorPid)) {
    process.kill(state.supervisorPid, "SIGTERM");
    const deadline = Date.now() + 20_000;
    while (processAlive(state.supervisorPid) && Date.now() < deadline) await delay(100);
    if (processAlive(state.supervisorPid))
      throw new Error("Supervisor did not stop within 20 seconds");
  } else {
    fs.rmSync(file, { force: true });
    run(config.toolchain.executables.docker, composeArgs(config, "stop", "postgres"));
  }
  process.stdout.write(
    `${JSON.stringify({ projectName: config.projectName, status: "stopped" })}\n`,
  );
}

try {
  const config = await loadEnvironment({ checkPorts: command === "start", envFile, root });
  if (command === "start") await start(config);
  else if (command === "status") await status(config);
  else await stop(config);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unknown local environment error"}\n`,
  );
  process.exitCode = 1;
}
