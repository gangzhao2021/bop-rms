import { describe, expect, it, vi } from "vitest";
import { createPostgresAvailabilityQueryStore } from "../index.js";
const id = (n: number) => `018f7100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-01T16:00:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2) };
const input = {
  ...scope,
  sellableReference: id(3),
  channelCode: "WEB",
  orderTypeCode: "PICKUP",
  observedAt: at,
};
function rule(change: Record<string, unknown> = {}) {
  return {
    ruleReference: id(4),
    brandReference: id(1),
    internalCode: "SYNTHETIC",
    aggregateVersion: 1,
    lifecycle: "Active",
    sellableReference: id(3),
    sellableType: "Sku",
    storeReference: id(2),
    channelCodes: ["WEB"],
    orderTypeCodes: ["PICKUP"],
    effectiveFrom: at,
    effectiveUntil: null,
    decision: "Available",
    priority: 10,
    reasonCode: "CONFIGURED",
    createdAt: at,
    createdByActorReference: id(5),
    updatedAt: at,
    ...change,
  };
}
function fixture(rows: unknown = [{ rule: rule() }]) {
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(async () => ({
    rows,
  }));
  const run = vi.fn(async () => undefined);
  return {
    query,
    run,
    store: createPostgresAvailabilityQueryStore(
      {
        async run(action) {
          await run();
          return action({ query });
        },
      },
      scope,
    ),
  };
}
describe("Catalog availability query store", () => {
  it("constructs without I/O and binds both SQL and RLS scope", async () => {
    const f = fixture();
    expect(f.run).not.toHaveBeenCalled();
    const rules = await f.store.loadCurrentRules(input);
    expect(rules).toEqual([rule()]);
    expect(Object.isFrozen(rules)).toBe(true);
    expect(Object.isFrozen(rules[0])).toBe(true);
    expect(f.query.mock.calls[0]?.[1]).toEqual([id(1), ""]);
    expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), id(3), "WEB", "PICKUP", at]);
    expect(f.query.mock.calls[1]?.[0]).toContain("store_id IS NULL OR store_id = $2");
  });
  it("preserves Brand defaults and conflicting Store decisions for domain resolution", async () => {
    const rows = [
      rule({ storeReference: null }),
      rule({ ruleReference: id(6), decision: "Unavailable" }),
    ];
    const f = fixture(rows.map((rule) => ({ rule })));
    expect(await f.store.loadCurrentRules(input)).toEqual(rows);
  });
  it("returns a frozen empty result without asserting availability", async () => {
    expect(await fixture([]).store.loadCurrentRules(input)).toEqual([]);
  });
  it.each([
    { brandReference: id(9) },
    { storeReference: id(9) },
    { sellableReference: "bad" },
    { channelCode: "bad code" },
    { observedAt: "bad" },
    { extra: true },
  ])("denies malformed/foreign request before I/O %j", async (change) => {
    const f = fixture();
    await expect(f.store.loadCurrentRules({ ...input, ...change })).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("does not evaluate request getters", async () => {
    const f = fixture();
    const getter = vi.fn(() => id(3));
    const value = Object.defineProperty({ ...input }, "sellableReference", { get: getter });
    await expect(f.store.loadCurrentRules(value)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("captures request values before transaction waits", async () => {
    const f = fixture();
    const value = { ...input };
    f.run.mockImplementation(async () => {
      value.sellableReference = id(9);
      value.channelCode = "OTHER";
    });
    await f.store.loadCurrentRules(value);
    expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), id(3), "WEB", "PICKUP", at]);
  });
  it.each([
    { brandReference: id(9) },
    { storeReference: id(9) },
    { sellableReference: id(9) },
    { lifecycle: "Inactive" },
    { channelCodes: ["POS"] },
    { orderTypeCodes: ["DINE_IN"] },
    { effectiveUntil: at, effectiveFrom: "2026-08-01T15:00:00.000Z" },
    { effectiveFrom: "2026-08-01T17:00:00.000Z" },
    { updatedAt: "2026-08-01T17:00:00.000Z" },
  ])("rejects inconsistent rows %j", async (change) => {
    await expect(
      fixture([{ rule: rule(change) }]).store.loadCurrentRules(input),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  });
  it.each([null, [{}], [{ rule: rule() }, { rule: rule() }]])(
    "rejects malformed or duplicate rows",
    async (rows) => {
      await expect(fixture(rows).store.loadCurrentRules(input)).rejects.toMatchObject({
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("bounds transaction errors", async () => {
    const f = fixture();
    f.run.mockRejectedValue(new Error("synthetic private detail"));
    await expect(f.store.loadCurrentRules(input)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  });
});
