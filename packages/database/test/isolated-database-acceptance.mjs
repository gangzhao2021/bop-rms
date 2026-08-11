import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const stages = [
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
];

async function proveDatabase(context) {
  assert.match(context.runId, /^[a-z0-9]{8,20}$/u);
  assert.match(context.databaseName, /^bop_rms_test_[a-z0-9]{8,20}_[a-z][a-z0-9_]{0,19}$/u);
  assert.equal(path.isAbsolute(context.fixtureRoot), true);
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    const evidence = await client.query(`SELECT
      current_database() AS database_name,
      count(*)::integer AS migration_count
      FROM platform_core.migration_history
      GROUP BY current_database()`);
    assert.deepEqual(evidence.rows, [{ database_name: context.databaseName, migration_count: 53 }]);
  } finally {
    await client.end();
  }
}

async function signalChild() {
  await withIsolatedDatabase({ caseId: "signal", root }, async (context) => {
    process.stdout.write(`ready:${context.runId}\n`);
    await new Promise(() => undefined);
  });
}

async function runSignal(signal, expectedExit) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--signal-child"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: "ignored", PGPASSWORD: "ignored" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sent = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!sent && stdout.includes("ready:")) {
        sent = true;
        child.kill(signal);
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, expectedExit, `${signal} child failed: ${stderr}`);
        assert(!stdout.includes("synthetic-"));
        assert(!stderr.includes("synthetic-"));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  await Promise.all([
    withIsolatedDatabase({ caseId: "parallel_a", root }, proveDatabase),
    withIsolatedDatabase({ caseId: "parallel_b", root }, proveDatabase),
  ]);

  for (const failureAt of stages) {
    await assert.rejects(
      withIsolatedDatabase({ caseId: "failure", failureAt, root }, proveDatabase),
      (error) => {
        assert.match(error.code, /^ISOLATED_DB_/u);
        assert(!error.message.includes("synthetic-"));
        return true;
      },
      `failure injection did not reject at ${failureAt}`,
    );
  }

  await assert.rejects(
    withIsolatedDatabase({ caseId: "timeout", root, timeoutMs: 25 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }),
    { code: "ISOLATED_DB_TIMEOUT" },
  );
  await runSignal("SIGINT", 130);
  await runSignal("SIGTERM", 143);
  process.stdout.write(
    "WP-0024 acceptance passed: parallel isolation, failure injection, signal, timeout, redaction, and cleanup\n",
  );
}

if (process.argv[2] === "--signal-child") {
  await signalChild();
} else {
  try {
    await main();
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : "ISOLATED_DB_INTERNAL";
    const detail = error instanceof Error ? error.message : "acceptance assertion failed";
    process.stderr.write(`${code}: WP-0024 acceptance failed (${detail})\n`);
    process.exitCode = code === "ISOLATED_DB_USAGE" || code === "ISOLATED_DB_INTERNAL" ? 2 : 1;
  }
}
