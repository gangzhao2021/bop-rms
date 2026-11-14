import { expect, it, vi } from "vitest";
import { createInternalReadTransactions } from "./pilot-read-transactions.mjs";
import { runWithRequestAcquireBudget } from "../../packages/database/dist/connection-acquire.js";
// WP-2423 (rush-connection-hold): a snapshot sitting idle is let go by the database after 5 s.
const begin =
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout = '2s'; " +
  "SET LOCAL idle_in_transaction_session_timeout = '5s'";
function fixture() {
  const connection = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
  const scope = { brandReference: "synthetic-brand", storeReference: "synthetic-store" };
  const run = createInternalReadTransactions({
    database: { acquire: async () => connection },
    scope,
  }).run;
  return { connection, scope, run };
}
it("uses a read-only scoped transaction and releases after successful work", async () => {
  const f = fixture();
  await expect(
    f.run(async (tx) => {
      await tx.query("SELECT synthetic_value", ["synthetic"]);
      return "read-result";
    }),
  ).resolves.toBe("read-result");
  expect(f.connection.query.mock.calls[0][0]).toBe(begin);
  expect(f.connection.query.mock.calls[1][1]).toEqual([
    f.scope.brandReference,
    f.scope.storeReference,
  ]);
  expect(f.connection.query.mock.calls.at(-1)[0]).toBe("COMMIT");
  expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(false);
});
it.each([false, true])(
  "releases failed work without exposing cause, rollback failure=%s",
  async (rollbackFails) => {
    const f = fixture();
    if (rollbackFails)
      f.connection.query.mockImplementation(async (sql) => {
        if (sql === "ROLLBACK") throw new Error("private-driver-detail");
        return { rows: [], rowCount: 0 };
      });
    await expect(
      f.run(async () => {
        throw new Error("private-query-detail");
      }),
    ).rejects.toThrow(/^INTERNAL_INVENTORY_READ_UNAVAILABLE$/);
    expect(f.connection.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(f.connection.query.mock.calls.at(-1)[0]).toBe("ROLLBACK");
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true);
  },
);

it("WP-2423 M35: sends a scope setting only when it changes one, and answers a repeated stable read", async () => {
  const f = fixture();
  const read = "SELECT snapshot_json FROM rms_catalog.sku WHERE sku_id=$1";
  f.connection.query.mockImplementation(async (sql) =>
    sql === read ? { rows: [{ snapshot_json: { v: 1 } }], rowCount: 1 } : { rows: [], rowCount: 0 },
  );
  await f.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      f.scope.brandReference,
      f.scope.storeReference,
    ]);
    expect(await tx.query("-- bop:stable-read\n" + read, ["s"])).toMatchObject({
      rows: [{ snapshot_json: { v: 1 } }],
    });
    expect(await tx.query("-- bop:stable-read\n" + read, ["s"])).toMatchObject({
      rows: [{ snapshot_json: { v: 1 } }],
    });
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      f.scope.brandReference,
    ]);
    await tx.query("SELECT 1", []);
  });
  expect(f.connection.query.mock.calls.map(([sql]) => sql)).toEqual([
    begin,
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    read,
    "SELECT set_config('bop.store_id',$1,true)",
    "SELECT 1",
    "COMMIT",
  ]);
});

it("WP-2423 M35: a checked UUIDv7 scope goes with BEGIN in one round trip; any other text is sent as parameters", async () => {
  const connection = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
  const brand = "01a0ff00-0000-7000-8000-000000000002",
    store = "01a0ff00-0000-7000-8000-000000000003";
  await createInternalReadTransactions({
    database: { acquire: async () => connection },
    scope: { brandReference: brand, storeReference: store },
  }).run(async (tx) => tx.query("SELECT 1", []));
  expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
    begin +
      "; " +
      `SELECT set_config('bop.brand_id', '${brand}', true), set_config('bop.store_id', '${store}', true)`,
    "SELECT 1",
    "COMMIT",
  ]);
  const quoted = fixture();
  quoted.scope.brandReference = "x', true); DROP TABLE y; --";
  await quoted.run(async () => undefined);
  expect(quoted.connection.query.mock.calls[0][0]).toBe(begin);
  expect(quoted.connection.query.mock.calls[1][1][0]).toBe("x', true); DROP TABLE y; --");
});

it("WP-2423 (rush-connection-hold): a read inside an open snapshot runs in it, on the connection held, never taking a second", async () => {
  const connection = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
  const acquire = vi.fn(async () => connection);
  const held = [];
  const database = {
    acquire,
    hold: async (work) => {
      held.push("begin");
      try {
        return await work();
      } finally {
        held.push("end");
      }
    },
  };
  const scope = { brandReference: "synthetic-brand", storeReference: "synthetic-store" };
  const reads = createInternalReadTransactions({ database, scope });
  // The same reads object (stock) and another made over the same database (as the pilot's items).
  const other = createInternalReadTransactions({ database, scope });
  const result = await reads.run(async (tx) => {
    await tx.query("SELECT outer_value", []);
    const stock = await other.run(async (nested) => {
      await nested.query("SELECT nested_value", []);
      return "stock";
    });
    // A nested read that fails is its own failure: the snapshot goes on.
    await expect(
      reads.run(async () => {
        throw new Error("private-query-detail");
      }),
    ).rejects.toThrow(/^INTERNAL_INVENTORY_READ_UNAVAILABLE$/);
    await tx.query("SELECT after_value", []);
    return stock;
  });
  expect(result).toBe("stock");
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(held).toEqual(["begin", "end"]);
  expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
    begin,
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    "SELECT outer_value",
    "SAVEPOINT bop_read_1",
    "SELECT nested_value",
    "RELEASE SAVEPOINT bop_read_1",
    "SAVEPOINT bop_read_2",
    "ROLLBACK TO SAVEPOINT bop_read_2",
    "SELECT after_value",
    "COMMIT",
  ]);
  expect(connection.release).toHaveBeenCalledExactlyOnceWith(false);
  // Another Store's reads never join this Store's snapshot.
  const elsewhere = createInternalReadTransactions({
    database,
    scope: { ...scope, storeReference: "synthetic-other-store" },
  });
  await reads.run(async () => elsewhere.run(async () => undefined));
  expect(acquire).toHaveBeenCalledTimes(3);
});

it("WP-2423 (rush-connection-hold): a read past its answer time sends nothing more and answers busy", async () => {
  const f = fixture();
  await runWithRequestAcquireBudget(
    10_000,
    async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
      await expect(f.run(async (tx) => tx.query("SELECT late", []))).rejects.toThrow(
        /^INTERNAL_INVENTORY_READ_UNAVAILABLE$/,
      );
    },
    { answerWithinMs: 1 },
  );
  expect(f.connection.query.mock.calls.map(([sql]) => sql)).not.toContain("SELECT late");
});
