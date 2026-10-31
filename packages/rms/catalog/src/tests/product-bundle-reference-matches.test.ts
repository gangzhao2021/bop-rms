import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildProductPricingBindingSourceSnapshot,
  buildProductReferenceHistorySourceSnapshot,
  buildBundleReferenceSourceSnapshot,
  matchProductBundleReferences,
  type ProductLifecycleReviewRequest,
} from "../index.js";
const id = (n: number) => `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z";
const request: ProductLifecycleReviewRequest = {
  purposeCode: "CATALOG_LIFECYCLE_REVIEW",
  brandReference: id(1),
  actorReference: id(2),
  productReference: id(3),
  skuReference: null,
  operationReference: id(4),
  expectedAggregateVersion: 2,
  originalProductVersionReference: id(5),
  beforeLifecycle: "Draft",
  targetLifecycle: "Archived",
  reasonCode: "SYNTHETIC",
  activeSkuCount: 0,
};
function graph(skus = [id(6)], version = id(5)) {
  return {
    versionReference: version,
    categoryClassificationKnown: false,
    categoryReferences: null,
    primaryCategoryReference: null,
    taxClassificationReference: null,
    skuReferences: skus,
    bindings: [],
  };
}
function member(_n: number, type = "Product", reference = id(3), old = false) {
  return {
    groupReference: id(old ? 32 : 31),
    bundleVersionReference: id(old ? 22 : 21),
    bundleReference: id(20),
    brandReference: id(1),
    sellableType: type,
    sellableReference: reference,
  };
}
function inputs(
  intent = request,
  members = [
    member(40),
    member(41, "Sku", id(6)),
    member(42, "Sku", id(7), true),
    member(43, "Product", id(99)),
  ],
  oldSkus = [id(6), id(7)],
) {
  const bundleRequest = {
    purposeCode: "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ" as const,
    brandReference: intent.brandReference,
    actorReference: intent.actorReference,
    operationReference: intent.operationReference,
    catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(intent)),
  };
  const raw = {
    generation: "7",
    counts: { bundles: "1", versions: "2", groups: "2", members: String(members.length) },
    observedAt: at,
    bundles: [
      {
        bundleReference: id(20),
        brandReference: id(1),
        aggregateVersion: 1,
        lifecycle: "Draft",
        currentVersionReference: id(21),
        updatedAt: at,
        precise: true,
      },
    ],
    versions: [
      {
        bundleVersionReference: id(21),
        bundleReference: id(20),
        brandReference: id(1),
        versionStatus: "Draft",
        versionUpdatedAt: at,
        publishedAt: null,
        validationDigest: null,
        precise: true,
      },
      {
        bundleVersionReference: id(22),
        bundleReference: id(20),
        brandReference: id(1),
        versionStatus: "Published",
        versionUpdatedAt: at,
        publishedAt: at,
        validationDigest: "sha256:" + "a".repeat(64),
        precise: true,
      },
    ],
    groups: [31, 32].map((n) => ({
      groupReference: id(n),
      bundleVersionReference: id(n === 31 ? 21 : 22),
      bundleReference: id(20),
      brandReference: id(1),
    })),
    members,
  };
  return {
    request: intent,
    catalogCurrent: buildProductPricingBindingSourceSnapshot(
      { observedAt: at, targetExists: true, precise: true, ...graph() },
      intent,
      at,
    ),
    catalogHistory: buildProductReferenceHistorySourceSnapshot(
      {
        observedAt: at,
        targetExists: true,
        recordedAggregateVersion: intent.expectedAggregateVersion,
        recordCoverage: true,
        configurations: [graph(), graph(oldSkus, id(8))],
      },
      intent,
      at,
    ),
    bundleSource: buildBundleReferenceSourceSnapshot(raw, bundleRequest, at),
    now: at,
  };
}
const denied = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
describe("held current and recorded Product to stored Bundle graphs", () => {
  it("matches each Product graph independently and retains current Draft plus historical Published Bundle context", () => {
    const value = inputs(),
      result = matchProductBundleReferences(value);
    expect(result.current.references.map((r) => r.member.sellableReference)).toEqual([
      id(3),
      id(6),
    ]);
    const old = result.recorded.find((r) => r.configuration.skuReferences.includes(id(7)));
    expect(old?.references.map((r) => r.member.sellableReference)).toEqual([id(3), id(6), id(7)]);
    expect(old?.references.find((r) => r.member.sellableReference === id(7))).toMatchObject({
      isCurrentBundleVersion: false,
      bundle: { currentVersionReference: id(21), lifecycle: "Draft" },
      version: { versionStatus: "Published", publishedAt: at },
      group: { groupReference: id(32) },
    });
    expect(result).toMatchObject({
      bundleGeneration: "7",
      bundleSourceDigest: value.bundleSource.digest,
      bundleReferenceCoverage: "CompleteStoredGraph",
      bundlePublicationCoverage: "Unavailable",
      publicationCoverage: "Unavailable",
      futureScheduleCoverage: "Unavailable",
      applicability: "Unavailable",
    });
    expect(Object.isFrozen(result.current.references)).toBe(true);
    expect(result.recorded.every((r) => r.configuration.categoryReferences === null)).toBe(true);
  });
  it("keeps absent selected SKU history empty without inheriting Product or other SKU references", () => {
    const r = matchProductBundleReferences(
      inputs({ ...request, skuReference: id(6) }, undefined, [id(7)]),
    );
    expect(r.current.references).toHaveLength(2);
    const old = r.recorded.find((r) => !r.configuration.skuReferences.includes(id(6)));
    expect(old).toMatchObject({ targetMembership: "Absent", references: [] });
  });
  it("preserves complete root/version/group source digest when there are no matching members", () => {
    const value = inputs(request, []),
      r = matchProductBundleReferences(value);
    expect(value.bundleSource.bundles).toHaveLength(1);
    expect(r.current.references).toEqual([]);
    expect(r.recorded.every((r) => r.references.length === 0)).toBe(true);
    expect(r.bundleSourceDigest).toBe(value.bundleSource.digest);
  });
  it("retains observations independently of stable data fingerprints", () => {
    const value = inputs(),
      a = matchProductBundleReferences(value),
      later = "2026-09-29T12:00:01.000Z",
      source = value.bundleSource;
    const bundleSource = buildBundleReferenceSourceSnapshot(
      {
        generation: source.generation,
        counts: { bundles: "1", versions: "2", groups: "2", members: "4" },
        observedAt: later,
        bundles: source.bundles.map((r) => ({ ...r, precise: true })),
        versions: source.versions.map((v) => ({ ...v, precise: true })),
        groups: source.groups,
        members: source.members,
      },
      source.request,
      later,
    );
    const b = matchProductBundleReferences({ ...value, bundleSource, now: later });
    expect(b.digest).toBe(a.digest);
    expect(b.observations).toEqual({ catalogCurrent: at, catalogHistory: at, bundle: later });
    expect(b.observedAt).toBe(at);
  });
  it.each([
    "operation",
    "expectedVersion",
    "reason",
    "target",
    "digest",
    "generation",
    "partial",
    "stale",
    "historyRevision",
    "graph",
  ])("refuses changed %s", (kind) => {
    const v = inputs();
    if (kind === "operation") v.request = { ...request, operationReference: id(70) };
    if (kind === "expectedVersion") v.request = { ...request, expectedAggregateVersion: 3 };
    if (kind === "reason") v.request = { ...request, reasonCode: "DIFFERENT" };
    if (kind === "target") v.request = { ...request, skuReference: id(7) };
    if (kind === "digest")
      v.bundleSource = { ...v.bundleSource, digest: "sha256:" + "b".repeat(64) };
    if (kind === "generation") v.bundleSource = { ...v.bundleSource, generation: "8" };
    if (kind === "partial")
      Object.assign((v.bundleSource = { ...v.bundleSource }), { coverage: "Partial" });
    if (kind === "stale") v.now = "2026-09-29T12:00:05.001Z";
    if (kind === "historyRevision")
      v.catalogHistory = { ...v.catalogHistory, recordedAggregateVersion: 3 };
    if (kind === "graph")
      v.catalogCurrent = buildProductPricingBindingSourceSnapshot(
        { observedAt: at, targetExists: true, precise: true, ...graph([id(6), id(9)]) },
        request,
        at,
      );
    expect(() => matchProductBundleReferences(v)).toThrow(denied);
  });
  it("rejects executable source data without calling its getter", () => {
    const v = inputs(),
      getter = vi.fn(() => []);
    Object.defineProperty((v.bundleSource = { ...v.bundleSource }), "members", {
      enumerable: true,
      get: getter,
    });
    expect(() => matchProductBundleReferences(v)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
  });
  it("fails rather than truncates repeated historical match output", () => {
    const many = Array.from({ length: 4000 }, (_, i) => member(100 + i, "Product", id(3), false));
    // Distinct groups preserve owning member uniqueness while repeating the target.
    const base = inputs(request, []),
      source = base.bundleSource;
    const groups = many
      .map((m, i) => ({ ...m, groupReference: id(1000 + i) }))
      .map(({ sellableReference, sellableType, ...g }) => {
        void sellableReference;
        void sellableType;
        return g;
      });
    const members = many.map((m, i) => ({ ...m, groupReference: id(1000 + i) }));
    const bundleSource = buildBundleReferenceSourceSnapshot(
      {
        generation: "7",
        counts: { bundles: "1", versions: "2", groups: "4000", members: "4000" },
        observedAt: at,
        bundles: source.bundles.map((r) => ({ ...r, precise: true })),
        versions: source.versions.map((v) => ({ ...v, precise: true })),
        groups,
        members,
      },
      source.request,
      at,
    );
    expect(() => matchProductBundleReferences({ ...base, bundleSource })).toThrow(denied);
  });
});
