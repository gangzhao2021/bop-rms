import { describe, expect, it, vi } from "vitest";
import {
  CatalogError,
  buildProductAvailabilitySourceSnapshot,
  createPostgresProductAvailabilitySourceStore,
  productAvailabilitySourceFields,
} from "../index.js";
import type { ProductLifecycleReviewRequest } from "../index.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
const id = (n: number) => `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z";
const request: ProductLifecycleReviewRequest = {
  purposeCode: "CATALOG_LIFECYCLE_REVIEW",
  brandReference: id(1),
  actorReference: id(2),
  productReference: id(3),
  skuReference: null,
  operationReference: id(4),
  expectedAggregateVersion: 1,
  originalProductVersionReference: id(5),
  beforeLifecycle: "Draft",
  targetLifecycle: "Archived",
  reasonCode: "SYNTHETIC_TEST",
  activeSkuCount: 0,
};
function raw() {
  return {
    observedAt: at,
    targetExists: true,
    skuReferences: [id(6)],
    rules: [
      {
        precise: true,
        rule: {
          ruleReference: id(7),
          brandReference: id(1),
          sellableType: "Sku",
          sellableReference: id(6),
          storeReference: id(8),
          aggregateVersion: 1,
          lifecycle: "Inactive",
          effectiveFrom: at,
          effectiveUntil: null,
          updatedAt: at,
        },
      },
    ],
  };
}
const build = (value: unknown, input = request, now = at) =>
  buildProductAvailabilitySourceSnapshot(value, input, now);
describe("complete Product Availability references", () => {
  it("keeps other Store, future, expired and nonactive references; stable content digest", () => {
    const source = raw(),
      first = source.rules[0];
    if (!first) throw new Error();
    source.rules.push({
      precise: true,
      rule: {
        ...first.rule,
        ruleReference: id(9),
        sellableType: "Product",
        sellableReference: request.productReference,
        lifecycle: "Draft",
        effectiveFrom: "2026-10-01T00:00:00.000Z",
      },
    });
    const result = build(source);
    expect(result).toMatchObject({
      coverage: "Complete",
      consistency: "StatementSnapshot",
      references: source.rules.map((r) => r.rule),
    });
    const digest = result.digest;
    source.rules.reverse();
    expect(
      build(
        { ...source, observedAt: "2026-09-29T12:00:01.000Z" },
        request,
        "2026-09-29T12:00:01.000Z",
      ).digest,
    ).toBe(digest);
    first.rule.aggregateVersion = 2;
    expect(build(source).digest).not.toBe(digest);
    expect(Object.isFrozen(result.references[0])).toBe(true);
  });
  it("accepts known existing target empty references, never missing target as zero", () => {
    expect(build({ ...raw(), skuReferences: [], rules: [] }).references).toEqual([]);
    expect(() => build({ ...raw(), targetExists: false, rules: [] })).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
  });
  it.each([
    [
      "foreign Brand",
      (s: ReturnType<typeof raw>) => {
        const r = s.rules[0];
        if (r) r.rule.brandReference = id(80);
      },
    ],
    [
      "unrelated SKU",
      (s: ReturnType<typeof raw>) => {
        const r = s.rules[0];
        if (r) r.rule.sellableReference = id(80);
      },
    ],
    [
      "wrong Product",
      (s: ReturnType<typeof raw>) => {
        const r = s.rules[0];
        if (r) {
          r.rule.sellableType = "Product";
          r.rule.sellableReference = id(80);
        }
      },
    ],
    [
      "duplicate rule",
      (s: ReturnType<typeof raw>) => {
        const r = s.rules[0];
        if (r) s.rules.push(r);
      },
    ],
    [
      "duplicate SKU",
      (s: ReturnType<typeof raw>) => {
        s.skuReferences.push(id(6));
      },
    ],
    [
      "imprecise",
      (s: ReturnType<typeof raw>) => {
        const r = s.rules[0];
        if (r) r.precise = false;
      },
    ],
    [
      "future update",
      (s: ReturnType<typeof raw>) => {
        const r = s.rules[0];
        if (r) r.rule.updatedAt = "2026-09-29T12:00:01.000Z";
      },
    ],
    [
      "invalid version",
      (s: ReturnType<typeof raw>) => {
        const r = s.rules[0];
        if (r) r.rule.aggregateVersion = 0;
      },
    ],
    [
      "oversized SKU set",
      (s: ReturnType<typeof raw>) => {
        s.skuReferences = Array.from({ length: 1001 }, (_, i) => id(i + 100));
      },
    ],
    [
      "oversized rule set",
      (s: ReturnType<typeof raw>) => {
        const r = s.rules[0];
        if (r) s.rules = Array.from({ length: 1001 }, () => r);
      },
    ],
  ])("rejects %s", (_, change) => {
    const s = raw();
    change(s);
    expect(() => build(s)).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
  });
  it("copies descriptors and rejects getter/sparse/unexpected data without evaluation", () => {
    const s = raw(),
      get = vi.fn(() => id(6));
    Object.defineProperty(s.skuReferences, "0", { enumerable: true, get });
    expect(() => build(s)).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
    expect(get).not.toHaveBeenCalled();
    expect(() => build({ ...raw(), rules: Array(1) })).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
    expect(() => build({ ...raw(), extra: true })).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
  });
  it("rejects stale/future statement and unrelated SKU request", () => {
    expect(() => build(raw(), request, "2026-09-29T12:00:05.001Z")).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
    expect(() => build(raw(), request, "2026-09-29T11:59:59.999Z")).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
    expect(() => build(raw(), { ...request, skuReference: id(80) })).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
  });
});
function fixture() {
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void values;
    return {
      rows: sql.includes("transaction_isolation")
        ? [{ isolation: "read committed" }]
        : sql.includes("source")
          ? [{ source: raw() }]
          : [],
    };
  });
  const tx = { query } as unknown as ProductLifecycleTransaction,
    hold = vi.fn(async (transaction: ProductLifecycleTransaction, input: unknown) => {
      void transaction;
      void input;
      return undefined;
    }),
    run = vi.fn(async (work: (tx: ProductLifecycleTransaction) => Promise<unknown>) => work(tx));
  const options = {
    tenantReference: id(10),
    brandReference: id(1),
    actorReference: id(2),
    transactions: {
      run: run as <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) => Promise<T>,
    },
    authority: { holdUntilTransactionCompletes: hold },
    clock: { now: () => at },
  };
  return {
    tx,
    query,
    hold,
    run,
    options,
    store: createPostgresProductAvailabilitySourceStore(options),
  };
}
describe("owning Availability source adapter", () => {
  it("requires authority before owner read and after source with exact server scope/fields", async () => {
    const f = fixture();
    expect((await f.store.loadSnapshot(request)).references).toHaveLength(1);
    expect(f.hold).toHaveBeenCalledTimes(2);
    expect(f.hold.mock.calls[0]).toEqual([
      f.tx,
      {
        tenantReference: id(10),
        actorReference: id(2),
        request,
        purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ",
        permission: "catalog.manage",
        requiredFields: productAvailabilitySourceFields,
        observedAt: at,
      },
    ]);
    const statement = f.query.mock.calls.find(([sql]) => sql.includes("targetExists"));
    expect(statement?.[1]).toEqual([id(1), id(3), null]);
  });
  it("fails foreign context before transaction and missing/denied authority before SQL", async () => {
    const f = fixture();
    await expect(f.store.loadSnapshot({ ...request, brandReference: id(90) })).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
    expect(f.run).not.toHaveBeenCalled();
    f.hold.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_PERMISSION_DENIED" }),
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it("rejects late authority loss and noncurrent isolation", async () => {
    const f = fixture();
    f.hold
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      });
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_PERMISSION_DENIED" }),
    );
    const other = fixture();
    other.query.mockResolvedValueOnce({ rows: [{ isolation: "repeatable read" }] } as never);
    await expect(other.store.loadSnapshot(request)).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
  });
  it("rejects runner bypass and private driver exceptions", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({} as never);
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
    f.query.mockRejectedValueOnce(new Error("private driver detail"));
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
  });
});
