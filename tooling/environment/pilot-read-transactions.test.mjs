import { expect, it, vi } from "vitest";
import { createInternalReadTransactions } from "./pilot-read-transactions.mjs";
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
  expect(f.connection.query.mock.calls[0][0]).toBe(
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout = '2s'",
  );
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
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout = '2s'",
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
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout = '2s'; " +
      `SELECT set_config('bop.brand_id', '${brand}', true), set_config('bop.store_id', '${store}', true)`,
    "SELECT 1",
    "COMMIT",
  ]);
  const quoted = fixture();
  quoted.scope.brandReference = "x', true); DROP TABLE y; --";
  await quoted.run(async () => undefined);
  expect(quoted.connection.query.mock.calls[0][0]).toBe(
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout = '2s'",
  );
  expect(quoted.connection.query.mock.calls[1][1][0]).toBe("x', true); DROP TABLE y; --");
});
