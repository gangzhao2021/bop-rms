import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { tmpdir } from "node:os";
import pg from "pg";
import { readMigrationCatalog } from "../src/catalog.ts";
import { runMigrationCommand } from "../src/runner.ts";

const { Client } = pg;
const owner = "wp-0024-isolated-database";
const databasePattern = /^bop_rms_test_([a-z0-9]{8,20})_([a-z][a-z0-9_]{0,19})$/u;
const casePattern = /^[a-z][a-z0-9_]{0,19}$/u;
const failureStages = new Set([
  "beforeComposeStart",
  "afterComposeStart",
  "afterDatabaseCreate",
  "duringMigration",
  "duringFixture",
  "duringBody",
  "cleanupClients",
  "cleanupDatabases",
  "cleanupLogs",
  "cleanupCompose",
  "cleanupLease",
  "cleanupRoot",
]);

class IsolatedDatabaseError extends Error {
  constructor(code, phase, message = "isolated database operation failed", cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "IsolatedDatabaseError";
    this.code = code;
    this.phase = phase;
  }
}

function normalizeCaseId(value) {
  if (typeof value !== "string" || !casePattern.test(value))
    throw new IsolatedDatabaseError("ISOLATED_DB_USAGE", "usage", "caseId is invalid");
  return value;
}

function generatedRunId() {
  return randomBytes(6).toString("hex");
}

function databaseIdentifier(value, registry) {
  assert(databasePattern.test(value), "database name must match the WP-0024 namespace");
  assert(registry.has(value), "database name must be registered to this run");
  return `"${value}"`;
}

function injected(stage, configured) {
  if (configured !== stage) return;
  const cleanup = stage.startsWith("cleanup");
  throw new IsolatedDatabaseError(
    cleanup ? "ISOLATED_DB_CLEANUP_FAILED" : "ISOLATED_DB_FIXTURE_FAILED",
    stage,
    `synthetic failure at ${stage}`,
  );
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const outputLimit = options.outputLimit ?? 1_048_576;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < outputLimit) stdout += chunk.slice(0, outputLimit - stdout.length);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < outputLimit) stderr += chunk.slice(0, outputLimit - stderr.length);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

async function allocatePort(runId) {
  const leaseRoot = path.join(await realpath(tmpdir()), "bop-rms-isolated-db-leases");
  await mkdir(leaseRoot, { mode: 0o700, recursive: true });
  const leaseState = await lstat(leaseRoot);
  const canonicalLeaseRoot = await realpath(leaseRoot);
  if (
    leaseState.isSymbolicLink() ||
    !leaseState.isDirectory() ||
    canonicalLeaseRoot !== leaseRoot ||
    (leaseState.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && leaseState.uid !== process.getuid())
  )
    throw new IsolatedDatabaseError(
      "ISOLATED_DB_LEASE_FAILED",
      "lease",
      "the isolated port lease root is unsafe",
    );
  const start = 55_000 + (Number.parseInt(runId.slice(0, 6), 16) % 5_000);
  for (let offset = 0; offset < 5_000; offset += 1) {
    const port = 55_000 + ((start - 55_000 + offset) % 5_000);
    const lease = path.join(leaseRoot, String(port));
    try {
      await mkdir(lease, { mode: 0o700 });
      await writeFile(path.join(lease, "owner"), `${owner}:${runId}\n`, { mode: 0o600 });
      return { lease, port };
    } catch (error) {
      if (error && error.code === "EEXIST") continue;
      throw new IsolatedDatabaseError(
        "ISOLATED_DB_LEASE_FAILED",
        "lease",
        "could not claim an isolated port lease",
        error,
      );
    }
  }
  throw new IsolatedDatabaseError(
    "ISOLATED_DB_LEASE_FAILED",
    "lease",
    "no isolated port lease is available",
  );
}

function composeArguments(root, project, composeEnv, ...args) {
  return [
    "compose",
    "--project-directory",
    root,
    "--project-name",
    project,
    "--env-file",
    composeEnv,
    "--file",
    path.join(root, "compose.yaml"),
    ...args,
  ];
}

async function projectResources(project, root, childEnvironment) {
  try {
    const filters = [`label=com.docker.compose.project=${project}`];
    const outputs = await Promise.all([
      run("docker", ["ps", "--all", "--quiet", "--filter", filters[0]], {
        cwd: root,
        env: childEnvironment,
        timeoutMs: 15_000,
      }),
      run("docker", ["volume", "ls", "--quiet", "--filter", filters[0]], {
        cwd: root,
        env: childEnvironment,
        timeoutMs: 15_000,
      }),
      run("docker", ["network", "ls", "--quiet", "--filter", filters[0]], {
        cwd: root,
        env: childEnvironment,
        timeoutMs: 15_000,
      }),
    ]);
    return outputs.flatMap((output) => (output.trim() === "" ? [] : output.trim().split("\n")));
  } catch {
    return [];
  }
}

export async function withIsolatedDatabase(options, testBody) {
  if (!options || typeof options !== "object" || typeof testBody !== "function")
    throw new IsolatedDatabaseError(
      "ISOLATED_DB_USAGE",
      "usage",
      "options and testBody are required",
    );
  if (options.environment !== undefined && options.environment !== "test")
    throw new IsolatedDatabaseError(
      "ISOLATED_DB_UNSAFE_ENVIRONMENT",
      "environment",
      "only the test environment is permitted",
    );
  if (options.host !== undefined && options.host !== "127.0.0.1")
    throw new IsolatedDatabaseError(
      "ISOLATED_DB_UNSAFE_ENVIRONMENT",
      "environment",
      "only the loopback host is permitted",
    );
  if (options.ssl !== undefined && options.ssl !== false)
    throw new IsolatedDatabaseError(
      "ISOLATED_DB_UNSAFE_ENVIRONMENT",
      "environment",
      "local isolated PostgreSQL requires the explicit loopback profile",
    );
  if (options.failureAt !== undefined && !failureStages.has(options.failureAt))
    throw new IsolatedDatabaseError("ISOLATED_DB_USAGE", "usage", "failureAt is invalid");

  const caseId = normalizeCaseId(options.caseId ?? "acceptance");
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, "../../.."));
  const runId = generatedRunId();
  const project = `bop-rms-test-${runId}`;
  const databaseName = `bop_rms_test_${runId}_${caseId}`;
  const adminDatabase = `bop_rms_test_${runId}_admin`;
  const user = `bop_rms_test_${runId}_runner`;
  const password = `synthetic-${randomBytes(18).toString("base64url")}`;
  const registeredDatabases = new Set([adminDatabase, databaseName]);
  const clients = new Set();
  let admin;
  let lease;
  let fixtureRoot;
  let controlRoot;
  let composeEnv;
  let primaryError;
  let cleanupError;
  let bodyResult;
  let signalExit;
  let signalPromise;
  const childEnvironment = { ...process.env };
  delete childEnvironment.DATABASE_URL;
  delete childEnvironment.PGPASSWORD;

  const cleanup = async () => {
    const failures = [];
    const attempt = async (stage, action) => {
      try {
        await action();
        injected(stage, options.failureAt);
      } catch (error) {
        failures.push(
          error instanceof IsolatedDatabaseError
            ? error
            : new IsolatedDatabaseError(
                "ISOLATED_DB_CLEANUP_FAILED",
                stage,
                `isolated cleanup failed at ${stage}`,
                error,
              ),
        );
      }
    };
    await attempt("cleanupClients", async () => {
      for (const client of clients) await client.end().catch(() => undefined);
      clients.clear();
    });
    await attempt("cleanupDatabases", async () => {
      if (admin) {
        for (const database of registeredDatabases) {
          if (database === adminDatabase) continue;
          await admin
            .query(
              `DROP DATABASE IF EXISTS ${databaseIdentifier(database, registeredDatabases)} WITH (FORCE)`,
            )
            .catch(() => undefined);
        }
        await admin.end().catch(() => undefined);
        admin = undefined;
      }
    });
    await attempt("cleanupLogs", async () => {
      if (composeEnv && fixtureRoot) {
        const logs = await run(
          "docker",
          composeArguments(root, project, composeEnv, "logs", "--no-color", "postgres"),
          { cwd: root, env: childEnvironment, timeoutMs: 15_000 },
        ).catch(() => "");
        if (logs.includes(password))
          throw new IsolatedDatabaseError(
            "ISOLATED_DB_CLEANUP_FAILED",
            "cleanupLogs",
            "PostgreSQL logs disclosed the synthetic password",
          );
      }
    });
    await attempt("cleanupCompose", async () => {
      if (composeEnv)
        await run(
          "docker",
          composeArguments(root, project, composeEnv, "down", "--volumes", "--remove-orphans"),
          { cwd: root, env: childEnvironment, timeoutMs: 60_000 },
        ).catch((error) => {
          throw new IsolatedDatabaseError(
            "ISOLATED_DB_CLEANUP_FAILED",
            "cleanupCompose",
            "owned Compose cleanup failed",
            error,
          );
        });
    });
    if (composeEnv) {
      const residue = composeEnv ? await projectResources(project, root, childEnvironment) : [];
      if (residue.length > 0)
        failures.push(
          new IsolatedDatabaseError(
            "ISOLATED_DB_RESIDUE",
            "residue",
            "owned Compose resources remain after cleanup",
          ),
        );
    }
    await attempt("cleanupLease", async () => {
      if (lease) await rm(lease.lease, { force: true, recursive: true });
    });
    await attempt("cleanupRoot", async () => {
      if (fixtureRoot) await rm(fixtureRoot, { force: true, recursive: true });
      if (controlRoot) await rm(controlRoot, { force: true, recursive: true });
    });
    cleanupError = failures[0];
  };

  const onSignal = (signal) => {
    signalExit = signal === "SIGINT" ? 130 : 143;
    signalPromise ??= cleanup().finally(() => process.exit(signalExit));
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    lease = await allocatePort(runId);
    fixtureRoot = await mkdtemp(path.join(tmpdir(), `bop-rms-test-${runId}-`));
    controlRoot = path.join(root, ".local", `wp0024-${runId}`);
    await mkdir(controlRoot, { mode: 0o700, recursive: true });
    const secret = path.join(controlRoot, "password");
    composeEnv = path.join(controlRoot, "compose.env");
    await writeFile(secret, password, { mode: 0o600 });
    await writeFile(
      composeEnv,
      [
        `BOP_RMS_COMPOSE_PROJECT=${project}`,
        "BOP_RMS_ENVIRONMENT=test",
        "BOP_RMS_POSTGRES_HOST=127.0.0.1",
        `BOP_RMS_POSTGRES_PASSWORD_FILE=${secret}`,
        `BOP_RMS_POSTGRES_PORT=${lease.port}`,
        `BOP_RMS_POSTGRES_DB=${adminDatabase}`,
        `BOP_RMS_POSTGRES_USER=${user}`,
        "BOP_RMS_POSTGRES_SSL_MODE=disable",
        `BOP_RMS_API_PORT=${lease.port + 5_000}`,
        `BOP_RMS_MERCHANT_WEB_PORT=${lease.port + 5_001}`,
        `BOP_RMS_CUSTOMER_PWA_PORT=${lease.port + 5_002}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const existing = await projectResources(project, root, childEnvironment);
    if (existing.length > 0)
      throw new IsolatedDatabaseError(
        "ISOLATED_DB_RESIDUE",
        "preflight",
        "owned resources existed before the run",
      );
    injected("beforeComposeStart", options.failureAt);
    await run(
      "docker",
      composeArguments(
        root,
        project,
        composeEnv,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "120",
        "postgres",
      ),
      { cwd: root, env: childEnvironment, timeoutMs: 150_000 },
    ).catch((error) => {
      throw new IsolatedDatabaseError(
        "ISOLATED_DB_START_FAILED",
        "composeStart",
        "isolated PostgreSQL failed to start",
        error,
      );
    });
    injected("afterComposeStart", options.failureAt);
    admin = new Client({
      application_name: owner,
      database: adminDatabase,
      host: "127.0.0.1",
      password,
      port: lease.port,
      user,
    });
    admin.on("error", (error) => {
      if (error.code !== "57P01" && error.message !== "Connection terminated unexpectedly")
        throw error;
    });
    await admin.connect();
    await admin.query(
      `CREATE DATABASE ${databaseIdentifier(databaseName, registeredDatabases)} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    injected("afterDatabaseCreate", options.failureAt);
    const clientConfig = {
      application_name: owner,
      database: databaseName,
      envFile: composeEnv,
      host: "127.0.0.1",
      password,
      port: lease.port,
      ssl: false,
      user,
    };
    const catalog = await readMigrationCatalog(root);
    if (catalog.diagnostics.length > 0)
      throw new IsolatedDatabaseError(
        "ISOLATED_DB_BOOTSTRAP_FAILED",
        "catalog",
        "migration catalog is invalid",
      );
    injected("duringMigration", options.failureAt);
    const migration = await runMigrationCommand({
      catalog,
      command: "apply",
      config: { ...clientConfig, environment: "test" },
      confirmTarget: `test:${databaseName}`,
    });
    if (migration.diagnostics.length > 0)
      throw new IsolatedDatabaseError(
        "ISOLATED_DB_BOOTSTRAP_FAILED",
        "migration",
        "isolated database bootstrap failed",
      );
    injected("duringFixture", options.failureAt);
    if (options.fixture) await options.fixture({ clientConfig, databaseName, fixtureRoot, runId });
    injected("duringBody", options.failureAt);
    const timeoutMs = options.timeoutMs ?? 300_000;
    let timeout;
    const timeoutFailure = new Promise((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new IsolatedDatabaseError(
              "ISOLATED_DB_TIMEOUT",
              "body",
              "isolated database body timed out",
            ),
          ),
        timeoutMs,
      );
    });
    bodyResult = await Promise.race([
      testBody({ clientConfig, databaseName, fixtureRoot, runId }),
      timeoutFailure,
    ]).finally(() => clearTimeout(timeout));
  } catch (error) {
    primaryError =
      error instanceof IsolatedDatabaseError
        ? error
        : new IsolatedDatabaseError(
            "ISOLATED_DB_INTERNAL",
            "internal",
            "isolated database operation failed",
            error,
          );
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (!signalPromise) await cleanup();
  }

  if (primaryError) {
    if (cleanupError) primaryError.cleanupError = cleanupError;
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return bodyResult;
}
