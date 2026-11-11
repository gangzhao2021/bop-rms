import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { acquirePilotConnection, guardPilotPoolConnections } from "./pilot-connections.mjs";

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
  attempts = -10;
  await expect(acquirePilotConnection(pool, quick)).rejects.toThrow("LOCAL_DATABASE_UNAVAILABLE");
  expect(attempts).toBe(-6);
});
