import { URL } from "node:url";
import { readFile, lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { createTenantTransactionRunner } from "../../packages/database/dist/transaction-runner.js";
import {
  acquireTenantConnection,
  noteTenantDatabaseAnswered,
  watchTenantConnectionPool,
} from "../../packages/database/dist/connection-acquire.js";
import { isPilotRuntime } from "./pilot-environment.mjs";
import {
  isPilotEntryProcess,
  pilotApiRoleMinimumLimit,
  pilotEntryAcquireBudgetMs,
  pilotEntryAcquireMs,
  pilotWorkerAcquireBudgetMs,
  pilotWorkerAcquireMs,
  pilotEffectiveRoleLimit,
  pilotProcessPoolSize,
  planPilotConnections,
} from "./pilot-connection-budget.mjs";
import { loadServedStoreDirectories } from "./pilot-served-stores.mjs";
import { alignProcessClockToDatabase } from "./pilot-database-clock.mjs";
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
/** WP-2423 M68 (a): this process's whole acquire budget for one request (entries 10 s). */
export const pilotAcquireBudgetMs = (entryFile = process.argv[1]) =>
  isPilotEntryProcess(entryFile) ? pilotEntryAcquireBudgetMs : pilotWorkerAcquireBudgetMs;
/**
 * WP-2423 M68 (a): a connection taken outside the transaction runner (admission, joins, snapshot
 * reads) gets the same retry with jitter, short pool waits until the request's acquire budget is
 * spent, before the request answers "busy, try again" (never a refusal).
 */
export async function acquirePilotConnection(pool, policy = {}) {
  try {
    return await acquireTenantConnection(pool, {
      budgetMs: pilotAcquireBudgetMs(),
      ...policy,
    });
  } catch {
    throw new Error("LOCAL_DATABASE_UNAVAILABLE");
  }
}
/** How often an entry's heartbeat asks the database (`startPilotDatabaseHeartbeat`). */
export const pilotDatabaseHeartbeatMs = 1000;
/**
 * WP-2423 (rush-logging-and-entry, v15 2026-11-13): an entry asks the database `SELECT 1` once a
 * second on a connection of its own, never one of its pool's, and notes each answer for the pool
 * (`noteTenantDatabaseAnswered`). In three live bursts the API's pool got nothing back for ten
 * seconds while the database answered the staff entry all the time, so every guest read turned away
 * by the rush was logged as a fault (level 50, HTTP_SERVER_ERROR). The heartbeat is answered in a
 * rush and not when the database hangs, restarts or cannot be reached, so a wait that ran out is
 * told apart: the rush (level 40, HTTP_RETRY_LATER) or a fault (level 50). Each ask is bounded by
 * the client's own 2 s limits; a failed one drops its connection and the next opens a new one.
 */
export function startPilotDatabaseHeartbeat(
  pool,
  openClient,
  {
    intervalMs = pilotDatabaseHeartbeatMs,
    schedule = (work, ms) => {
      const handle = setTimeout(work, ms);
      handle.unref?.();
      return handle;
    },
    cancel = clearTimeout,
  } = {},
) {
  let client = null;
  let stopped = false;
  let timer;
  const end = (target) => {
    try {
      void Promise.resolve(target?.end()).catch(() => undefined);
    } catch {
      /* Already ended. */
    }
  };
  const beat = async () => {
    if (stopped) return;
    let opening = null;
    try {
      if (client === null) {
        opening = openClient();
        // An error on the heartbeat's own connection never reaches the process.
        opening.on("error", () => {
          if (client === opening) client = null;
        });
        await opening.connect();
        if (stopped) return end(opening);
        client = opening;
        opening = null;
      }
      await client.query("SELECT 1");
      if (!stopped) noteTenantDatabaseAnswered(pool);
    } catch {
      end(opening);
      end(client);
      client = null;
    } finally {
      if (!stopped) timer = schedule(() => void beat(), intervalMs);
    }
  };
  timer = schedule(() => void beat(), 0);
  return Object.freeze({
    stop() {
      stopped = true;
      cancel(timer);
      end(client);
      client = null;
    },
  });
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
/**
 * WP-2423 (burst 2026-11-02): one pool per process and role. An entry serves every Store from one
 * process; separate pools left one Store's guests waiting beside another Store's idle connections.
 */
const sharedPools = new Map();
async function openPool(service, config) {
  // Sized from the Stores served and the role's real limit, so the pools of every process fit.
  // Unreadable: the smallest pool, and the first real query reports the cause.
  const limit = await readPilotRoleLimit({ ...config, connectionTimeoutMillis: 2000 });
  const entry = isPilotEntryProcess(process.argv[1]);
  const planned =
    service === "api" && limit !== null
      ? pilotProcessPoolSize(
          planPilotConnections({ storeCount: await servedStoreCount(), limit }),
          process.argv[1],
        )
      : 2;
  const pool = new Pool({
    ...config,
    // An entry's heartbeat (below) holds one of its planned connections.
    max: entry ? Math.max(1, planned - 1) : planned,
    connectionTimeoutMillis: isPilotEntryProcess(process.argv[1])
      ? pilotEntryAcquireMs
      : pilotWorkerAcquireMs,
    query_timeout: 5000,
    idleTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  guardPilotPoolConnections(pool);
  // WP-2423 (reads-under-burst, b12 review): its handed-out clients are counted from the start,
  // so a wait for a pool full of work is told apart from a database that cannot be reached.
  watchTenantConnectionPool(pool);
  // WP-2423 (rush-logging-and-entry): an entry's requests wait on its pool; the heartbeat tells
  // whether the database answers while they do (the rush) or not (a fault).
  const heartbeat = entry
    ? startPilotDatabaseHeartbeat(
        pool,
        () =>
          new Client({
            ...config,
            connectionTimeoutMillis: 2000,
            query_timeout: 2000,
            statement_timeout: 2000,
          }),
      )
    : null;
  return { pool, heartbeat };
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
  const shared = sharedPools.get(service + ":" + database);
  const opened = shared === undefined ? await openPool(service, config) : null;
  const pool = shared?.pool ?? opened.pool;
  if (shared === undefined)
    sharedPools.set(service + ":" + database, { pool, heartbeat: opened.heartbeat, users: 1 });
  else shared.users += 1;
  if (process.env.PILOT_CLOCK_FROM_DATABASE === "1")
    await alignProcessClockToDatabase((sql) => pool.query(sql));
  let closing;
  return Object.freeze({
    transactions: (scope) =>
      createTenantTransactionRunner(pool, scope, { acquireBudgetMs: pilotAcquireBudgetMs() }),
    acquire: () => acquirePilotConnection(pool),
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
      // The last user of the process's pool ends it.
      closing ??= (async () => {
        const entry = sharedPools.get(service + ":" + database);
        if (entry === undefined || --entry.users > 0) return;
        sharedPools.delete(service + ":" + database);
        entry.heartbeat?.stop();
        await pool.end();
      })();
      return closing;
    },
  });
}
