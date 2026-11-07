import { describe, expect, it, vi } from "vitest";
import {
  CatalogError,
  buildProductBundleSourceSnapshot,
  createPostgresProductBundleSourceStore,
  productBundleSourceFields,
  type ProductLifecycleReviewRequest,
} from "../index.js";
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
function reference() {
  return {
    bundleReference: id(10),
    brandReference: id(1),
    aggregateVersion: 1,
    lifecycle: "Draft",
    currentVersionReference: id(11),
    updatedAt: at,
    bundleVersionReference: id(11),
    versionStatus: "Draft",
    versionUpdatedAt: at,
    publishedAt: null as string | null,
    validationDigest: null as string | null,
    groupReference: id(12),
    sellableType: "Sku",
    sellableReference: id(6),
  };
}
function raw() {
  return {
    observedAt: at,
    targetExists: true,
    skuReferences: [id(6), id(7)],
    references: [{ precise: true, coherent: true, reference: reference() }],
  };
}
const build = (value: unknown, input = request, now = at) =>
  buildProductBundleSourceSnapshot(value, input, now);
const denied = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
describe("complete Product/SKU Bundle reference source", () => {
  it("keeps historical Published and current Draft separate; stable content digest", () => {
    const input = raw();
    input.references.push({
      precise: true,
      coherent: true,
      reference: {
        ...reference(),
        bundleVersionReference: id(13),
        groupReference: id(14),
        versionStatus: "Published",
        publishedAt: at,
        validationDigest: `sha256:${"a".repeat(64)}`,
        sellableType: "Product",
        sellableReference: id(3),
      },
    });
    const result = build(input);
    expect(result.references.map((r) => [r.versionStatus, r.isCurrentVersion])).toEqual([
      ["Draft", true],
      ["Published", false],
    ]);
    expect(Object.isFrozen(result.references[0])).toBe(true);
    input.references.reverse();
    input.skuReferences.reverse();
    expect(
      build(
        { ...input, observedAt: "2026-09-29T12:00:01.000Z" },
        request,
        "2026-09-29T12:00:01.000Z",
      ).digest,
    ).toBe(result.digest);
    for (const r of input.references) r.reference.aggregateVersion = 2;
    expect(build(input).digest).not.toBe(result.digest);
  });
  it("accepts known empty but not missing target; exact SKU membership", () => {
    expect(build({ ...raw(), skuReferences: [], references: [] }).references).toEqual([]);
    expect(() => build({ ...raw(), targetExists: false, references: [] })).toThrow(denied);
    expect(
      build({ ...raw(), skuReferences: [id(6)] }, { ...request, skuReference: id(6) }).references,
    ).toHaveLength(1);
    expect(() => build(raw(), { ...request, skuReference: id(6) })).toThrow(denied);
  });
  it.each([
    [
      "foreign Brand",
      (r: ReturnType<typeof reference>) => {
        r.brandReference = id(90);
      },
    ],
    [
      "foreign SKU",
      (r: ReturnType<typeof reference>) => {
        r.sellableReference = id(90);
      },
    ],
    [
      "foreign Product",
      (r: ReturnType<typeof reference>) => {
        r.sellableType = "Product";
        r.sellableReference = id(90);
      },
    ],
    [
      "invalid lifecycle",
      (r: ReturnType<typeof reference>) => {
        r.lifecycle = "Active";
      },
    ],
    [
      "invalid version",
      (r: ReturnType<typeof reference>) => {
        r.aggregateVersion = 0;
      },
    ],
    [
      "Published without evidence",
      (r: ReturnType<typeof reference>) => {
        r.versionStatus = "Published";
      },
    ],
    [
      "Draft with Published evidence",
      (r: ReturnType<typeof reference>) => {
        r.publishedAt = at;
      },
    ],
    [
      "future root",
      (r: ReturnType<typeof reference>) => {
        r.updatedAt = "2026-09-29T12:00:01.000Z";
      },
    ],
    [
      "future version",
      (r: ReturnType<typeof reference>) => {
        r.versionUpdatedAt = "2026-09-29T12:00:01.000Z";
      },
    ],
  ])("rejects %s", (_, change) => {
    const input = raw(),
      row = input.references[0];
    if (!row) throw new Error();
    change(row.reference);
    expect(() => build(input)).toThrow(denied);
  });
  it.each(["root", "version", "group", "duplicate"])("rejects incoherent %s identity", (kind) => {
    const input = raw(),
      other = { ...reference(), sellableReference: id(7) };
    if (kind === "root") other.aggregateVersion = 2;
    if (kind === "version") other.versionUpdatedAt = "2026-09-29T11:59:59.000Z";
    if (kind === "group") other.bundleVersionReference = id(90);
    if (kind === "duplicate") other.sellableReference = id(6);
    input.references.push({ precise: true, coherent: true, reference: other });
    expect(() => build(input)).toThrow(denied);
  });
  it("rejects overflow, stale/imprecise and executable driver data", () => {
    const input = raw();
    expect(() =>
      build({ ...input, skuReferences: Array.from({ length: 1001 }, (_, n) => id(n + 100)) }),
    ).toThrow(denied);
    expect(() =>
      build({
        ...input,
        references: Array.from({ length: 1001 }, () => ({
          precise: true,
          coherent: true,
          reference: reference(),
        })),
      }),
    ).toThrow(denied);
    expect(() =>
      build({ ...input, references: [{ precise: false, coherent: true, reference: reference() }] }),
    ).toThrow(denied);
    expect(() =>
      build({ ...input, references: [{ precise: true, coherent: false, reference: reference() }] }),
    ).toThrow(denied);
    expect(() => build(input, request, "2026-09-29T12:00:05.001Z")).toThrow(denied);
    expect(() => build(input, request, "2026-09-29T11:59:59.999Z")).toThrow(denied);
    const getter = vi.fn(() => reference());
    Object.defineProperty(input.references, "0", { enumerable: true, get: getter });
    expect(() => build(input)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
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
    tenantReference: id(20),
    brandReference: id(1),
    actorReference: id(2),
    transactions: {
      run: run as <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) => Promise<T>,
    },
    authority: { holdUntilTransactionCompletes: hold },
    clock: { now: () => at },
  };
  return { query, tx, hold, run, options, store: createPostgresProductBundleSourceStore(options) };
}
describe("owning Bundle source adapter", () => {
  it("uses exact authority and owner request before/after current statement", async () => {
    const f = fixture();
    expect((await f.store.loadSnapshot(request)).coverage).toBe("Complete");
    expect(f.hold).toHaveBeenCalledTimes(2);
    expect(f.hold.mock.calls[0]).toEqual([
      f.tx,
      {
        tenantReference: id(20),
        actorReference: id(2),
        request,
        purposeCode: "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ",
        permission: "catalog.manage",
        requiredFields: productBundleSourceFields,
        observedAt: at,
      },
    ]);
    expect(f.query.mock.calls.find(([sql]) => sql.includes("targetExists"))?.[1]).toEqual([
      id(1),
      id(3),
      null,
    ]);
  });
  it("rejects foreign context/missing authority before private reads and late denial", async () => {
    const f = fixture();
    await expect(f.store.loadSnapshot({ ...request, actorReference: id(90) })).rejects.toThrow(
      denied,
    );
    expect(f.run).not.toHaveBeenCalled();
    f.hold.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_PERMISSION_DENIED" }),
    );
    expect(f.query).not.toHaveBeenCalled();
    f.hold
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      });
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_PERMISSION_DENIED" }),
    );
  });
  it("rejects stale isolation, runner bypass and private driver errors", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows: [{ isolation: "repeatable read" }] } as never);
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(denied);
    f.run.mockResolvedValueOnce({} as never);
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(denied);
    f.query.mockRejectedValueOnce(new Error("private driver detail"));
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(denied);
  });
});
