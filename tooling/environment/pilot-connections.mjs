import { URL } from "node:url";
import { readFile, lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";
import { createTenantTransactionRunner } from "../../packages/database/dist/transaction-runner.js";
import { isPilotRuntime } from "./pilot-environment.mjs";
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const { Pool } = require("pg");

export async function createApplicationDatabase(
  service,
  { passwordFile, host, port, database, user },
) {
  if (!["api", "worker"].includes(service) || !isPilotRuntime({ test: true, unset: "development" }))
    throw new Error("LOCAL_DATABASE_CONFIGURATION_UNAVAILABLE");
  const file = passwordFile(service);
  const state = await lstat(file);
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    (state.mode & 0o777) !== 0o600 ||
    state.uid !== process.getuid() ||
    (await realpath(file)) !== file
  )
    throw new Error("LOCAL_DATABASE_CONFIGURATION_UNAVAILABLE");
  const password = await readFile(file, "utf8");
  if (!/^[a-f0-9]{64}$/u.test(password))
    throw new Error("LOCAL_DATABASE_CONFIGURATION_UNAVAILABLE");
  const pool = new Pool({
    host,
    port,
    database,
    user: user(service),
    password,
    ssl: false,
    max: 5,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
    idleTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  pool.on("error", () => {
    process.stderr.write('{"event":"local_database_connection_failed"}\n');
  });
  let closing;
  return Object.freeze({
    transactions: (scope) => createTenantTransactionRunner(pool, scope),
    async acquire() {
      try {
        return await pool.connect();
      } catch {
        throw new Error("LOCAL_DATABASE_UNAVAILABLE");
      }
    },
    async probe() {
      if (closing) return "not_ready";
      try {
        const result = await pool.query("SELECT 1 AS connected");
        return result.rows[0]?.connected === 1 ? "ready" : "not_ready";
      } catch {
        return "not_ready";
      }
    },
    close() {
      closing ??= pool.end();
      return closing;
    },
  });
}
