import { describe, it, expect } from "vitest";
import { createConsumerDeliveryDatabase } from "./consumer-transaction.js";
const scope = {
  brandId: "0198a107-0000-7000-8000-000000000001",
  storeId: "0198a107-0000-7000-8000-000000000002",
};
function fixture(fail?: string) {
  const calls: unknown[] = [];
  const database = createConsumerDeliveryDatabase({
    acquire: async () => ({
      query: async (sql, values) => {
        calls.push([sql, values]);
        if (sql === fail) throw Error("synthetic connection failure");
        return { rows: [], rowCount: 0 };
      },
      release: (discard) => {
        calls.push(["release", discard]);
      },
    }),
  });
  return { database, calls };
}
describe("consumer database transaction", () => {
  it("sets scope before work and releases after acknowledged commit", async () => {
    const f = fixture();
    expect(
      await f.database.transaction(scope, async (tx) => {
        await tx.query("SELECT 1", []);
        return "done";
      }),
    ).toBe("done");
    expect(f.calls).toEqual([
      ["BEGIN", []],
      [
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandId, scope.storeId],
      ],
      ["SELECT 1", []],
      ["COMMIT", []],
      ["release", false],
    ]);
  });
  it("rolls back a handler failure", async () => {
    const f = fixture();
    await expect(
      f.database.transaction(scope, async () => {
        throw Error("handler");
      }),
    ).rejects.toThrow("handler");
    expect(f.calls.slice(-2)).toEqual([
      ["ROLLBACK", []],
      ["release", false],
    ]);
  });
  it("discards uncertain commit without claiming rollback", async () => {
    const f = fixture("COMMIT");
    await expect(f.database.transaction(scope, async () => "done")).rejects.toMatchObject({
      errorCode: "COMMIT_OUTCOME_UNKNOWN",
    });
    expect(f.calls.at(-1)).toEqual(["release", true]);
    expect(f.calls).not.toContainEqual(["ROLLBACK", []]);
  });
  it("does not acquire for invalid scope", async () => {
    const f = fixture();
    await expect(
      f.database.transaction({ brandId: "invalid" }, async () => null),
    ).rejects.toMatchObject({ errorCode: "CONSUMER_TEMPORARY_FAILURE" });
    expect(f.calls).toEqual([]);
  });
});
