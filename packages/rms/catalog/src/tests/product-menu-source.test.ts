import { describe, expect, it, vi } from "vitest";
import {
  CatalogError,
  buildProductMenuSourceSnapshot,
  createPostgresProductMenuSourceStore,
  productMenuSourceFields,
  type ProductLifecycleReviewRequest,
} from "../index.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
const id = (n: number) => `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  digest = `sha256:${"a".repeat(64)}`;
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
    coverageComplete: true,
    skuReferences: [id(6), id(7)],
    productVersionReferences: [id(5)],
    reviews: [
      {
        reviewReference: id(10),
        brandReference: id(1),
        menuReference: id(11),
        menuVersionReference: id(12),
        snapshotDigest: digest,
        createdAt: at,
        coherent: true,
        placements: [
          {
            sectionReference: id(13),
            placementReference: id(14),
            skuReference: id(6),
            productVersionReference: id(5),
          },
        ],
        lifecycle: { state: "Published", version: 4, changedAt: at, coherent: true },
        releases: [
          {
            releaseReference: id(15),
            releaseSequence: 1,
            releaseKind: "Publish",
            lifecycleVersion: 4,
            snapshotDigest: digest,
            createdAt: at,
            coherent: true,
            periods: [
              {
                timingReference: id(16),
                timeZone: "America/Toronto",
                effectiveFrom: at,
                effectiveUntil: null as string | null,
                periodDigest: digest,
                createdAt: at,
                precise: true,
              },
            ],
          },
        ],
      },
    ],
  };
}
const build = (v: unknown, input = request, now = at) =>
    buildProductMenuSourceSnapshot(v, input, now),
  denied = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
describe("complete reviewed Menu Product impact source", () => {
  it("separates timing, lifecycle and immutable release; stable content digest and no labels/health", () => {
    const s = raw(),
      r = s.reviews[0];
    if (!r) throw new Error();
    const result = build(s);
    expect(result.reviews[0]?.releases[0]?.periods[0]?.temporalStatus).toBe("Effective");
    expect(JSON.stringify(result)).not.toMatch(/allergen|localizedNames|price/);
    r.lifecycle.state = "Archived";
    const archived = build(s);
    expect(archived.digest).not.toBe(result.digest);
    expect(archived.reviews[0]?.releases[0]?.periods[0]?.temporalStatus).toBe("Effective");
    expect(
      build({ ...s, observedAt: "2026-09-29T12:00:01.000Z" }, request, "2026-09-29T12:00:01.000Z")
        .digest,
    ).toBe(archived.digest);
    const period = r.releases[0]?.periods[0];
    if (!period) throw new Error();
    period.effectiveFrom = "2026-10-01T00:00:00.000Z";
    expect(build(s).reviews[0]?.releases[0]?.periods[0]?.temporalStatus).toBe("Future");
    period.effectiveFrom = "2026-09-28T00:00:00.000Z";
    period.effectiveUntil = at;
    expect(build(s).reviews[0]?.releases[0]?.periods[0]?.temporalStatus).toBe("Expired");
    expect(Object.isFrozen(result.reviews[0]?.placements)).toBe(true);
  });
  it("keeps absent lifecycle unknown; known empty target source vs missing target", () => {
    const s = raw(),
      r = s.reviews[0];
    if (!r) throw new Error();
    expect(
      build({ ...s, reviews: [{ ...r, lifecycle: null, releases: [] }] }).reviews[0]?.lifecycle,
    ).toBeNull();
    expect(build({ ...s, reviews: [] }).reviews).toEqual([]);
    expect(() => build({ ...s, targetExists: false, reviews: [] })).toThrow(denied);
  });
  it("validates all review placements before target filter and scopes individual SKU", () => {
    const s = raw(),
      r = s.reviews[0];
    if (!r) throw new Error();
    r.placements.push({
      sectionReference: id(13),
      placementReference: id(17),
      skuReference: id(7),
      productVersionReference: id(5),
    });
    expect(build(s).reviews[0]?.placements).toHaveLength(2);
    expect(
      build({ ...s, skuReferences: [id(6)] }, { ...request, skuReference: id(6) }).reviews[0]
        ?.placements,
    ).toHaveLength(1);
    r.placements.push({
      sectionReference: id(18),
      placementReference: id(19),
      skuReference: id(90),
      productVersionReference: id(91),
    });
    expect(build(s).reviews[0]?.placements).toHaveLength(2);
    r.placements[2] = {
      sectionReference: id(18),
      placementReference: id(19),
      skuReference: "invalid",
      productVersionReference: id(91),
    };
    expect(() => build(s)).toThrow(denied);
  });
  it.each([
    "coverage",
    "target-version",
    "review-shape",
    "foreign-brand",
    "duplicate-review",
    "duplicate-placement",
    "owner-linkage",
    "lifecycle",
    "release",
    "period",
    "timezone",
    "overflow",
  ])("rejects %s", (kind) => {
    const s = raw(),
      r = s.reviews[0];
    if (!r) throw new Error();
    const rel = r.releases[0],
      p = rel?.periods[0];
    if (!rel || !p) throw new Error();
    if (kind === "coverage") s.coverageComplete = false;
    if (kind === "target-version") s.productVersionReferences = [id(90)];
    if (kind === "review-shape") r.coherent = false;
    if (kind === "foreign-brand") r.brandReference = id(90);
    if (kind === "duplicate-review") s.reviews.push(r);
    if (kind === "duplicate-placement") {
      const x = r.placements[0];
      if (x) r.placements.push(x);
    }
    if (kind === "owner-linkage") {
      const x = r.placements[0];
      if (x) x.productVersionReference = id(90);
    }
    if (kind === "lifecycle") r.lifecycle.coherent = false;
    if (kind === "release") rel.coherent = false;
    if (kind === "period") p.precise = false;
    if (kind === "timezone") p.timeZone = "Fake/Zone";
    if (kind === "overflow") s.reviews = Array.from({ length: 1001 }, () => r);
    expect(() => build(s)).toThrow(denied);
  });
  it("requires an IANA zone instead of Intl-supported numeric offset", () => {
    const s = raw(),
      period = s.reviews[0]?.releases[0]?.periods[0];
    if (!period) throw new Error();
    period.timeZone = "+01:00";
    expect(() => build(s)).toThrow(denied);
  });
  it("rejects unknown lifecycle release, future revision, sparse/getter and stale statement", () => {
    const s = raw(),
      r = s.reviews[0];
    if (!r) throw new Error();
    expect(() => build({ ...s, reviews: [{ ...r, lifecycle: null }] })).toThrow(denied);
    r.lifecycle.changedAt = "2026-09-29T12:00:01.000Z";
    expect(() => build(s)).toThrow(denied);
    expect(() => build({ ...raw(), reviews: Array(1) })).toThrow(denied);
    const getter = vi.fn(() => raw().reviews[0]);
    Object.defineProperty(s.reviews, "0", { enumerable: true, get: getter });
    expect(() => build(s)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
    expect(() => build(raw(), request, "2026-09-29T12:00:05.001Z")).toThrow(denied);
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
  return { tx, query, hold, run, store: createPostgresProductMenuSourceStore(options) };
}
describe("actual owning Menu source adapter", () => {
  it("binds exact parent/request/purpose/fields around owner read", async () => {
    const f = fixture();
    expect((await f.store.loadSnapshot(request)).reviews).toHaveLength(1);
    expect(f.hold).toHaveBeenCalledTimes(2);
    expect(f.hold.mock.calls[0]).toEqual([
      f.tx,
      {
        tenantReference: id(20),
        actorReference: id(2),
        request,
        purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ",
        permission: "catalog.manage",
        requiredFields: productMenuSourceFields,
        observedAt: at,
      },
    ]);
    expect(f.query.mock.calls.find(([sql]) => sql.includes("targetExists"))?.[1]).toEqual([
      id(1),
      id(3),
      null,
    ]);
  });
  it("rejects foreign scope before transaction and authority loss before/after read", async () => {
    const f = fixture();
    await expect(f.store.loadSnapshot({ ...request, brandReference: id(90) })).rejects.toThrow(
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
  it("rejects noncurrent isolation, transaction bypass and hidden driver errors", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows: [{ isolation: "repeatable read" }] } as never);
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(denied);
    f.run.mockResolvedValueOnce({} as never);
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(denied);
    f.query.mockRejectedValueOnce(new Error("private driver details"));
    await expect(f.store.loadSnapshot(request)).rejects.toThrow(denied);
  });
});
