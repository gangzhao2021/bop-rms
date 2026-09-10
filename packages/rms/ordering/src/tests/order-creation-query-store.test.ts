import { describe, it, expect, vi } from "vitest";
import { createPostgresOrderCreationQueryStore } from "../index.js";
import { orderQueryFixture } from "./order-creation-query.fixture.js";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture");
  return value;
}
function setup(result: unknown) {
  const fixture = orderQueryFixture();
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    void values;
    return sql.startsWith("SELECT jsonb_build_object") ? result : { rows: [] };
  });
  const run = vi.fn();
  const store = createPostgresOrderCreationQueryStore(
    {
      async run<T>(action: (tx: { query: typeof query }) => Promise<T>) {
        run();
        return action({ query });
      },
    },
    fixture.scope,
  );
  return { fixture, query, run, store };
}
describe("WP-2350 original Order history query", () => {
  it("recovers exact multi-line immutable facts in one scoped read-only observation", async () => {
    const f = orderQueryFixture(),
      x = setup({ rows: [{ history: f.history }] });
    expect(await x.store.resolveSubmission(f.record.submissionReference)).toEqual(f.record);
    expect(x.query).toHaveBeenCalledTimes(3);
    expect(x.query.mock.calls[0]).toEqual(["SET TRANSACTION READ ONLY", []]);
    expect(x.query.mock.calls[1]?.[1]).toEqual([f.scope.brandReference, f.scope.storeReference]);
    expect(x.query.mock.calls[2]?.[1]).toEqual([
      f.scope.brandReference,
      f.scope.storeReference,
      f.record.submissionReference,
    ]);
    expect(x.query.mock.calls[2]?.[0]).toContain("LIMIT 101");
    expect(x.query.mock.calls[2]?.[0]).toContain("ORDER BY i.ordinal");
  });
  it("returns null only for a missing scoped submission", async () => {
    const x = setup({ rows: [] });
    expect(await x.store.resolveSubmission(x.fixture.record.submissionReference)).toBeNull();
  });
  it.each([
    "ordinal",
    "quantity",
    "catalogDigest",
    "quoteDigest",
    "capturedAt",
    "cartItemReference",
    "orderItemReference",
    "orderBatchReference",
  ])("rejects contradictory item %s", async (field) => {
    const f = orderQueryFixture();
    const h = structuredClone(f.history);
    Object.assign(required(h.items[0]), {
      [field]: field === "ordinal" ? null : field === "quantity" ? 9 : "invalid",
    });
    const x = setup({ rows: [{ history: h }] });
    await expect(x.store.resolveSubmission(f.record.submissionReference)).rejects.toMatchObject({
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each(["cart", "version", "quote", "businessDate", "orderNumber"])(
    "rejects contradictory submission %s",
    async (field) => {
      const f = orderQueryFixture(),
        h = structuredClone(f.history);
      Object.assign(h.source, { [field]: "invalid" });
      await expect(
        setup({ rows: [{ history: h }] }).store.resolveSubmission(f.record.submissionReference),
      ).rejects.toMatchObject({ code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" });
    },
  );
  it.each(["gap", "reverse", "duplicate", "legacy", "missing", "sequence", "scope", "submission"])(
    "rejects %s history",
    async (kind) => {
      const f = orderQueryFixture(),
        h = structuredClone(f.history);
      if (kind === "gap") required(h.items[1]).ordinal = 3;
      if (kind === "reverse") h.items.reverse();
      if (kind === "duplicate") h.items[1] = required(h.items[0]);
      if (kind === "legacy") required(h.items[0]).snapshot = { catalog: {}, pricing: {} };
      if (kind === "missing") h.items = [];
      if (kind === "sequence") h.record.orderNumberAllocation.sequence = "01";
      if (kind === "scope") h.record.order.storeReference = f.record.order.brandReference;
      if (kind === "submission") h.record.submissionReference = f.record.order.orderReference;
      await expect(
        setup({ rows: [{ history: h }] }).store.resolveSubmission(f.record.submissionReference),
      ).rejects.toMatchObject({ code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" });
    },
  );
  it.each([
    "rows getter",
    "item getter",
    "iterator",
    "sparse",
    "cycle",
    "extra row",
    "duplicate row",
    "null",
  ])("rejects malformed %s without running hooks", async (kind) => {
    const f = orderQueryFixture();
    let executed = 0;
    const row = { history: f.history };
    let result: unknown = { rows: [row] };
    if (kind === "rows getter")
      result = {
        get rows() {
          executed++;
          return [row];
        },
      };
    if (kind === "item getter")
      Object.defineProperty(f.history.items, "0", {
        enumerable: true,
        get() {
          executed++;
          return null;
        },
      });
    if (kind === "iterator")
      Object.defineProperty(f.history.items, Symbol.iterator, {
        value() {
          executed++;
          return [];
        },
      });
    if (kind === "sparse") result = { rows: new Array(1) };
    if (kind === "cycle") Object.assign(f.history, { record: f.history });
    if (kind === "extra row") Object.assign(row, { extra: true });
    if (kind === "duplicate row") result = { rows: [row, row] };
    if (kind === "null") result = null;
    const x = setup(result);
    await expect(x.store.resolveSubmission(f.record.submissionReference)).rejects.toMatchObject({
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    });
    expect(executed).toBe(0);
  });
  it("bounds dependency and transaction-finalization errors", async () => {
    const f = orderQueryFixture();
    const store = createPostgresOrderCreationQueryStore(
      {
        async run() {
          throw new Error("private synthetic detail");
        },
      },
      f.scope,
    );
    await expect(store.resolveSubmission(f.record.submissionReference)).rejects.toMatchObject({
      message: "order creation is unavailable",
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("validates the reference before opening a transaction", async () => {
    const x = setup({ rows: [] });
    await expect(x.store.resolveSubmission("bad")).rejects.toBeDefined();
    expect(x.run).not.toHaveBeenCalled();
  });
});
