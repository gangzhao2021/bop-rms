import { URL } from "node:url";
import { readFile, lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";
import { createTenantTransactionRunner } from "../../packages/database/dist/transaction-runner.js";
import { isPilotRuntime } from "./pilot-environment.mjs";
import {
  pilotApiRoleMinimumLimit,
  pilotEffectiveRoleLimit,
  pilotProcessPoolSize,
  planPilotConnections,
} from "./pilot-connection-budget.mjs";
import { loadServedStoreDirectories } from "./pilot-served-stores.mjs";
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const { Client, Pool } = require("pg");

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
/** This role's usable connections, read from the database itself; null when it can't be read. */
export async function readPilotRoleLimit(config) {
  const client = new Client(config);
  try {
    await client.connect();
    const row = (
      await client.query(
        "SELECT rolconnlimit AS limit,current_setting('max_connections')::int AS max FROM pg_catalog.pg_roles WHERE rolname = current_user",
      )
    ).rows[0];
    return pilotEffectiveRoleLimit({ roleLimit: row.limit, maxConnections: row.max });
  } catch {
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
}
/** The installation's directory from this process's own arguments, a Store's or its own. */
async function servedStoreCount(argument = process.argv[2]) {
  if (typeof argument !== "string") return 1;
  try {
    return 1 + (await loadServedStoreDirectories(argument.replace(/\/stores\/[^/]+$/u, ""))).length;
  } catch {
    return 1;
  }
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
  const config = { host, port, database, user: user(service), password, ssl: false };
  // WP-2423 (2026-11-02): sized from the Stores served and the role's real limit, so the pools of
  // every process fit. Unreadable: the smallest pool, and the first real query reports the cause.
  const limit = await readPilotRoleLimit({ ...config, connectionTimeoutMillis: 2000 });
  const pool = new Pool({
    ...config,
    max:
      service === "api" && limit !== null
        ? pilotProcessPoolSize(
            planPilotConnections({ storeCount: await servedStoreCount(), limit }),
            process.argv[1],
          )
        : 2,
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
          (row.limit === -1 || (service === "api" ? row.limit >= pilotApiRoleMinimumLimit : true))
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
