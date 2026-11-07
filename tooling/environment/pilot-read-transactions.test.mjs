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
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  expect(f.connection.query.mock.calls[2][1]).toEqual([
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
