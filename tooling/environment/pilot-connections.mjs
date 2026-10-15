import { URL } from "node:url";
import { readFile, lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";
import { createTenantTransactionRunner } from "../../packages/database/dist/transaction-runner.js";
import { isPilotRuntime } from "./pilot-environment.mjs";
import { pilotApiRoleConnectionLimit, pilotPoolSize } from "./pilot-connection-budget.mjs";
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const { Pool } = require("pg");

/**
 * WP-2423 pilot resilience (2026-10-15): a terminated connection must never exit the process.
 * pg-pool listens for 'error' only while a client is idle; a checked-out client the server ends
 * between queries (25P03 idle-in-transaction timeout, 57P01 shutdown, ECONNRESET) emitted an
 * unhandled 'error' and took the guest site down three times in v15. Every client gets a permanent
 * listener: the request in flight fails (its handler answers 503 with Retry-After), the broken
 * client is discarded on release, and the pool opens a fresh connection for the next request.
 */
export function guardPilotPoolConnections(pool, write = (line) => process.stderr.write(line)) {
  const report = (error) => {
    try {
      const code = error?.code;
      write(
        JSON.stringify({
          event: "local_database_connection_failed",
          sqlState: typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : null,
        }) + "\n",
      );
    } catch {
      /* Diagnostics never change request handling. */
    }
  };
  pool.on("error", report);
  pool.on("connect", (client) => client.on("error", report));
  return pool;
}
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
    max: pilotPoolSize,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
    idleTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  guardPilotPoolConnections(pool);
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
        const result = await pool.query(
          "SELECT 1 AS connected, rolconnlimit AS limit FROM pg_catalog.pg_roles WHERE rolname = current_user",
        );
        const row = result.rows[0];
        return row?.connected === 1 &&
          (row.limit === -1 ||
            (service === "api" ? row.limit >= pilotApiRoleConnectionLimit : true))
          ? "ready"
          : "not_ready";
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
