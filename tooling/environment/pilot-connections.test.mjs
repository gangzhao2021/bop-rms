import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers";
import { expect, it } from "vitest";
import {
  acquirePilotConnection,
  guardPilotPoolConnections,
  pilotAcquireBudgetMs,
  pilotDatabaseHeartbeatMs,
  pilotDatabaseHeartbeatReopenBeats,
  startPilotDatabaseHeartbeat,
} from "./pilot-connections.mjs";

// WP-2423 pilot resilience (2026-10-15): v15 customer process exited three times on an unhandled
// 'error' (FATAL 25P03, "Connection terminated unexpectedly") from a checked-out pool client.
it("handles errors of idle and checked-out clients instead of exiting the process", () => {
  const pool = new EventEmitter(),
    lines = [];
  guardPilotPoolConnections(pool, (line) => lines.push(JSON.parse(line)));
  const client = new EventEmitter();
  pool.emit("connect", client);
  // Without a listener EventEmitter#emit('error') throws: that throw was the process exit.
  const fatal = Object.assign(Error("terminating connection due to idle-in-transaction timeout"), {
    code: "25P03",
    severity: "FATAL",
  });
  expect(() => client.emit("error", fatal)).not.toThrow();
  expect(() => client.emit("error", Error("Connection terminated unexpectedly"))).not.toThrow();
  expect(() => pool.emit("error", fatal, client)).not.toThrow();
  expect(lines).toEqual([
    { event: "local_database_connection_failed", sqlState: "25P03" },
    { event: "local_database_connection_failed", sqlState: null },
    { event: "local_database_connection_failed", sqlState: "25P03" },
  ]);
  expect(JSON.stringify(lines)).not.toContain("idle-in-transaction");
  const unguarded = new EventEmitter();
  expect(() => unguarded.emit("error", fatal)).toThrow();
});

it("WP-2423 M68: a guest's connection is retried through a brief exhaustion, then reads as busy", async () => {
  const ready = { release: () => undefined };
  let attempts = 0;
  const pool = {
    options: { connectionTimeoutMillis: 5000 },
    async connect() {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("too many clients"), { code: "53300" });
      return ready;
    },
  };
  const quick = { sleep: async () => undefined };
  expect(await acquirePilotConnection(pool, quick)).toBe(ready);
  expect(attempts).toBe(3);
  attempts = -1000;
  await expect(acquirePilotConnection(pool, { ...quick, retries: 5 })).rejects.toThrow(
    "LOCAL_DATABASE_UNAVAILABLE",
  );
  expect(attempts).toBe(-994);
});

it("WP-2423 M68: an entry retries a full pool for 10 s, a worker for one 2 s wait", async () => {
  expect(pilotAcquireBudgetMs("/app/tooling/environment/pilot-api-entry.mjs")).toBe(10_000);
  expect(pilotAcquireBudgetMs("/app/tooling/environment/pilot-https-entry.mjs")).toBe(10_000);
  expect(pilotAcquireBudgetMs("/app/tooling/environment/pilot-business-worker.mjs")).toBe(2000);
  let at = 0;
  let attempts = 0;
  const ready = { release: () => undefined };
  // Every pooled connection busy: each attempt waits the pool's 2 s, the fourth gets one.
  const pool = {
    options: { connectionTimeoutMillis: 2000 },
    async connect() {
      attempts += 1;
      if (attempts === 4) return ready;
      at += 2000;
      throw new Error("timeout exceeded when trying to connect");
    },
  };
  const policy = {
    budgetMs: 10_000,
    now: () => at,
    sleep: async (ms) => {
      at += ms;
    },
  };
  expect(await acquirePilotConnection(pool, policy)).toBe(ready);
  expect(attempts).toBe(4);
});

it("WP-2423 (rush-logging-and-entry): an entry's heartbeat asks on its own connection and notes each answer for the pool", async () => {
  const beats = [];
  const schedule = (work, ms) => {
    beats.push({ work, ms });
    return beats.length;
  };
  const opened = [];
  let answer = "ok";
  const openClient = () => {
    const client = Object.assign(new EventEmitter(), {
      connected: false,
      ended: false,
      async connect() {
        if (answer === "refused") throw new Error("connect ECONNREFUSED");
        this.connected = true;
      },
      async query(sql) {
        expect(sql).toBe("SELECT 1");
        if (answer === "hangs") throw new Error("Query read timeout");
      },
      async end() {
        this.ended = true;
      },
    });
    opened.push(client);
    return client;
  };
  const pool = Object.assign(new EventEmitter(), { options: { max: 2 }, totalCount: 2 });
  const heartbeat = startPilotDatabaseHeartbeat(pool, openClient, {
    schedule,
    cancel: () => undefined,
  });
  const next = async () => {
    const beat = beats.shift();
    await beat.work();
    await new Promise((resolve) => setImmediate(resolve));
  };
  // First beat at once, then every second, on one connection while it answers.
  expect(beats[0].ms).toBe(0);
  await next();
  await next();
  expect(beats[0].ms).toBe(pilotDatabaseHeartbeatMs);
  expect(opened).toHaveLength(1);
  // An unanswered ask drops its connection; the next beat opens a new one.
  answer = "hangs";
  await next();
  expect(opened[0].ended).toBe(true);
  answer = "refused";
  await next();
  expect(opened).toHaveLength(2);
  expect(opened[1].ended).toBe(true);
  answer = "ok";
  await next();
  expect(opened).toHaveLength(3);
  // An error on the heartbeat's own connection never reaches the process, and the connection is
  // dropped at once: the next beat opens a new one instead of losing a beat on a dead connection.
  expect(() => opened[2].emit("error", new Error("terminated"))).not.toThrow();
  expect(opened[2].ended).toBe(true);
  await next();
  expect(opened).toHaveLength(4);
  expect(opened[3].ended).toBe(false);
  // Review: an answer only on an old connection never shows new ones can be opened, so after
  // its answered asks the connection is closed and the next beat opens a new one.
  for (let ask = 1; ask < pilotDatabaseHeartbeatReopenBeats; ask += 1) await next();
  expect(opened).toHaveLength(4);
  expect(opened[3].ended).toBe(true);
  await next();
  expect(opened).toHaveLength(5);
  // New connections that cannot be opened stop the answers, though the last one worked.
  answer = "refused";
  for (let ask = 1; ask < pilotDatabaseHeartbeatReopenBeats; ask += 1) await next();
  await next();
  expect(opened).toHaveLength(6);
  expect(opened[5].connected).toBe(false);
  heartbeat.stop();
  expect(opened.every((client) => client.ended)).toBe(true);
});

it("WP-2423 (rush-logging-and-entry): a guest read whose wait ran out with no pool answer for 10 s is the rush while the heartbeat is answered, a fault when it is not", async () => {
  // v15 2026-11-13: the API pool had no answer for ten seconds while the database answered the
  // staff entry; the waits ran out in the pool's own queue and on handshakes still opening.
  const { runWithRequestAcquireBudget, watchTenantConnectionPool } =
    await import("../../packages/database/dist/connection-acquire.js");
  const store = () =>
    globalThis[Symbol.for("bop.database.request-acquire-budget")]?.getStore() ?? {};
  const outcome = async (heartbeatAnswers) => {
    // The pool is watched on the wall clock, as openPool watches it.
    let at = Date.now();
    const beats = [];
    const pool = Object.assign(new EventEmitter(), {
      options: { max: 2, connectionTimeoutMillis: 2000 },
      totalCount: 2,
      async connect() {
        at += 2000;
        // The heartbeat goes on asking while the request waits.
        const beat = beats.shift();
        if (beat !== undefined) await beat();
        throw new Error(
          beats.length % 2 === 0
            ? "timeout exceeded when trying to connect"
            : "Connection terminated due to connection timeout",
        );
      },
    });
    watchTenantConnectionPool(pool);
    // One client out with work, the pool's last answer long before the request.
    pool.emit("acquire");
    pool.emit("release", undefined);
    pool.emit("acquire");
    at += 10_000;
    const heartbeat = startPilotDatabaseHeartbeat(
      pool,
      () =>
        Object.assign(new EventEmitter(), {
          connect: async () => undefined,
          query: async () => {
            if (!heartbeatAnswers) throw new Error("Query read timeout");
          },
          end: async () => undefined,
        }),
      { schedule: (work) => beats.push(work), cancel: () => undefined },
    );
    const result = await runWithRequestAcquireBudget(10_000, async () => {
      const error = await acquirePilotConnection(pool, {
        budgetMs: 10_000,
        now: () => at,
        sleep: async (ms) => {
          at += ms;
        },
      }).catch((caught) => caught);
      return { message: error?.message, shed: store().shed === true, faulted: store().faulted };
    });
    heartbeat.stop();
    return result;
  };
  expect(await outcome(true)).toEqual({
    message: "LOCAL_DATABASE_UNAVAILABLE",
    shed: true,
    faulted: undefined,
  });
  expect(await outcome(false)).toEqual({
    message: "LOCAL_DATABASE_UNAVAILABLE",
    shed: false,
    faulted: true,
  });
});
