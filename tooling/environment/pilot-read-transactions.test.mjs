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
      f.run(async (tx) => {
        await tx.query("SELECT synthetic_value", []);
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
  await quoted.run(async (tx) => tx.query("SELECT 1", []));
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
    // logs-and-transaction-time: not released (COMMIT ends it); the failed read sent nothing,
    // so it took no savepoint and has nothing to roll back.
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

// WP-2423 (logs-and-transaction-time, v15 2026-11-14): under a burst a cart read's snapshot stayed
// open for seconds: 79 statements for two dishes, 41 of them repeats of a read already answered in
// it, and a savepoint taken and released around every nested read, even one that sent nothing.
it("logs-and-transaction-time: a plain read repeated in the snapshot under the same scope is answered from its first answer", async () => {
  const f = fixture();
  const read = "SELECT jsonb_build_object('v', v) AS row FROM rms_catalog.sku WHERE sku_id=$1";
  let served = 0;
  f.connection.query.mockImplementation(async (sql) =>
    sql === read || sql === "SELECT clock_timestamp() AS at"
      ? { rows: [{ row: { v: (served += 1) } }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  );
  await f.run(async (tx) => {
    const first = await tx.query(read, ["s"]);
    const again = await tx.query(read, ["s"]);
    expect(again.rows).toEqual([{ row: { v: 1 } }]);
    // A copy: changing one answer never changes the next.
    again.rows[0].row.v = 99;
    expect((await tx.query(read, ["s"])).rows).toEqual([{ row: { v: 1 } }]);
    expect(first.rows).toEqual([{ row: { v: 1 } }]);
    // Another value, or another scope, is another read.
    await tx.query(read, ["t"]);
    await tx.query("SELECT set_config('bop.store_id',$1,true)", [""]);
    await tx.query(read, ["s"]);
    // The running clock always reaches the database.
    await tx.query("SELECT clock_timestamp() AS at", []);
    await tx.query("SELECT clock_timestamp() AS at", []);
  });
  expect(f.connection.query.mock.calls.map(([sql, values]) => [sql, values?.[0]])).toEqual([
    [begin, undefined],
    [
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      f.scope.brandReference,
    ],
    [read, "s"],
    [read, "t"],
    ["SELECT set_config('bop.store_id',$1,true)", ""],
    [read, "s"],
    ["SELECT clock_timestamp() AS at", undefined],
    ["SELECT clock_timestamp() AS at", undefined],
    ["COMMIT", undefined],
  ]);
});

it("logs-and-transaction-time: the snapshot's own mode is read once whatever the scope, and a nested read that sent a statement and failed is rolled back", async () => {
  const connection = {
    query: vi.fn(async (sql) =>
      sql.startsWith("SELECT current_setting")
        ? { rows: [{ isolation: "repeatable read", read_only: "on" }], rowCount: 1 }
        : sql === "SELECT broken"
          ? Promise.reject(new Error("private-detail"))
          : { rows: [], rowCount: 0 },
    ),
    release: vi.fn(),
  };
  const scope = { brandReference: "synthetic-brand", storeReference: "synthetic-store" };
  const reads = createInternalReadTransactions({
    database: { acquire: async () => connection },
    scope,
  });
  const mode =
    "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only";
  await reads.run(async (tx) => {
    await tx.query(mode, []);
    await tx.query("SELECT set_config('bop.store_id',$1,true)", [""]);
    expect((await tx.query(mode, [])).rows).toEqual([
      { isolation: "repeatable read", read_only: "on" },
    ]);
    await expect(reads.run(async (nested) => nested.query("SELECT broken", []))).rejects.toThrow(
      /^INTERNAL_INVENTORY_READ_UNAVAILABLE$/,
    );
    await tx.query("SELECT after", []);
  });
  // WP-2423 M35 (staff round round trips): the mode is the one the snapshot is begun with.
  expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
    begin,
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    "SAVEPOINT bop_read_1",
    "SELECT set_config('bop.store_id',$1,true)",
    "SELECT broken",
    "ROLLBACK TO SAVEPOINT bop_read_1",
    "SELECT after",
    "COMMIT",
  ]);
});

it("WP-2423 M35 (staff round round trips): the snapshot begins with its first statement, with the scope it runs under, and answers its own mode", async () => {
  const connection = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
  const brand = "01a0ff00-0000-7000-8000-000000000002",
    store = "01a0ff00-0000-7000-8000-000000000003",
    tenant = "01a0ff00-0000-7000-8000-000000000001";
  const reads = createInternalReadTransactions({
    database: { acquire: async () => connection },
    scope: { brandReference: brand, storeReference: store },
  });
  const mode =
    "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only";
  const scope =
    "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store";
  await reads.run(async (tx) => {
    // As the database answers it in this snapshot (a read-only REPEATABLE READ cannot change).
    expect((await tx.query(mode, [])).rows).toEqual([
      { isolation: "repeatable read", read_only: "on" },
    ]);
    expect((await tx.query(scope, [])).rows).toEqual([{ brand, store }]);
    // A menu read leaves the Store scope for the Brand's rows: that goes with BEGIN.
    await tx.query("SELECT set_config('bop.store_id',$1,true)", [""]);
    await tx.query("SELECT menu_value", []);
    expect((await tx.query(scope, [])).rows).toEqual([{ brand, store: "" }]);
    await tx.query(
      "SELECT set_config('bop.store_id',$1,true),set_config('bop.tenant_id',$2,true)",
      [store, tenant],
    );
    await tx.query("SELECT stock_value", []);
  });
  expect(connection.query.mock.calls.map(([sql, values]) => [sql, values])).toEqual([
    [
      begin +
        "; " +
        `SELECT set_config('bop.brand_id', '${brand}', true), set_config('bop.store_id', '${store}', true)` +
        "; SELECT set_config('bop.store_id', '', true)",
      undefined,
    ],
    ["SELECT menu_value", []],
    [
      "SELECT set_config('bop.store_id',$1,true),set_config('bop.tenant_id',$2,true)",
      [store, tenant],
    ],
    ["SELECT stock_value", []],
    ["COMMIT", undefined],
  ]);
  expect(connection.release).toHaveBeenCalledExactlyOnceWith(false);
  // A snapshot answered wholly here, or whose work failed before it sent anything, sends nothing.
  connection.query.mockClear();
  await reads.run(async (tx) => tx.query(mode, []));
  await expect(
    reads.run(async () => {
      throw new Error("private-query-detail");
    }),
  ).rejects.toThrow(/^INTERNAL_INVENTORY_READ_UNAVAILABLE$/);
  expect(connection.query).not.toHaveBeenCalled();
});

it("WP-2423 M35 (staff round round trips): a nested read that sends the first statement sends its scope after its savepoint, never with BEGIN", async () => {
  const connection = {
    query: vi.fn(async (sql) =>
      sql === "SELECT broken" ? Promise.reject(new Error("private-detail")) : { rows: [] },
    ),
    release: vi.fn(),
  };
  const brand = "01a0ff00-0000-7000-8000-000000000002",
    store = "01a0ff00-0000-7000-8000-000000000003";
  const reads = createInternalReadTransactions({
    database: { acquire: async () => connection },
    scope: { brandReference: brand, storeReference: store },
  });
  await reads.run(async () => {
    await expect(
      reads.run(async (nested) => {
        await nested.query("SELECT set_config('bop.store_id',$1,true)", [""]);
        await nested.query("SELECT broken", []);
      }),
    ).rejects.toThrow(/^INTERNAL_INVENTORY_READ_UNAVAILABLE$/);
  });
  expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
    begin +
      "; " +
      `SELECT set_config('bop.brand_id', '${brand}', true), set_config('bop.store_id', '${store}', true)`,
    "SAVEPOINT bop_read_1",
    "SELECT set_config('bop.store_id',$1,true)",
    "SELECT broken",
    "ROLLBACK TO SAVEPOINT bop_read_1",
    "COMMIT",
  ]);
});

it("WP-2423 M35 (staff round round trips): reads made together share one snapshot, and the work answers and fails as its own", async () => {
  const connection = {
    query: vi.fn(async (sql) =>
      sql === "SELECT broken" ? Promise.reject(new Error("private-detail")) : { rows: [] },
    ),
    release: vi.fn(),
  };
  const acquire = vi.fn(async () => connection);
  const brand = "01a0ff00-0000-7000-8000-000000000002",
    store = "01a0ff00-0000-7000-8000-000000000003";
  const reads = createInternalReadTransactions({
    database: { acquire },
    scope: { brandReference: brand, storeReference: store },
  });
  const rejected = new Error("SoldOut");
  const answer = await reads.together(async () => {
    await reads.run((tx) => tx.query("SELECT menu_value", []));
    await reads.run((tx) => tx.query("SELECT stock_value", []));
    // Inside an open snapshot it runs in that one.
    return reads.together(async () => reads.run((tx) => tx.query("SELECT alcohol_value", [])));
  });
  expect(answer).toEqual({ rows: [] });
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
    begin +
      "; " +
      `SELECT set_config('bop.brand_id', '${brand}', true), set_config('bop.store_id', '${store}', true)`,
    "SAVEPOINT bop_read_1",
    "SELECT menu_value",
    "SAVEPOINT bop_read_2",
    "SELECT stock_value",
    "SAVEPOINT bop_read_3",
    "SELECT alcohol_value",
    "COMMIT",
  ]);
  // The work's own refusal is its answer, not "couldn't read"; a failed read is that read's.
  await expect(
    reads.together(async () => {
      throw rejected;
    }),
  ).rejects.toBe(rejected);
  await expect(
    reads.together(async () => reads.run((tx) => tx.query("SELECT broken", []))),
  ).rejects.toThrow(/^INTERNAL_INVENTORY_READ_UNAVAILABLE$/);
});
