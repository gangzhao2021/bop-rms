import { describe, it, expect, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildProductPricingBindingSourceSnapshot,
  buildProductReferenceHistorySourceSnapshot,
  buildMenuReferenceSourceSnapshot,
  matchProductMenuReferences,
  type ProductLifecycleReviewRequest,
} from "../index.js";
const id = (n: number) => `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
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
function placement(n = 31, sku = id(6), version = id(5)) {
  return {
    reviewReference: id(10),
    sectionReference: id(30),
    placementReference: id(n),
    skuReference: sku,
    productVersionReference: version,
  };
}
function menuRaw(placements = [placement(), placement(32, id(7), id(8))]) {
  const parent = {
    reviewReference: id(10),
    brandReference: id(1),
    menuReference: id(20),
    menuVersionReference: id(21),
    snapshotDigest: hash,
  };
  return {
    generation: "7",
    observedAt: at,
    counts: {
      reviews: "2",
      placements: String(placements.length),
      revisions: "2",
      releases: "1",
      periods: "1",
    },
    reviews: [
      { ...parent, createdAt: at, precise: true },
      {
        ...parent,
        reviewReference: id(11),
        menuVersionReference: id(22),
        createdAt: at,
        precise: true,
      },
    ],
    placements,
    revisions: [
      { ...parent, lifecycleVersion: 3, state: "Published", changedAt: at, precise: true },
      { ...parent, lifecycleVersion: 4, state: "Superseded", changedAt: at, precise: true },
    ],
    releases: [
      {
        ...parent,
        releaseReference: id(50),
        lifecycleVersion: 3,
        releaseSequence: 1,
        previousReleaseReference: null,
        releaseKind: "Publish",
        createdAt: at,
        precise: true,
      },
    ],
    periods: [
      {
        timingReference: id(60),
        releaseReference: id(50),
        brandReference: id(1),
        menuReference: id(20),
        timeZone: "America/Toronto",
        effectiveFrom: "2027-01-01T00:00:00.000Z",
        effectiveUntil: null,
        periodDigest: hash,
        createdAt: at,
        precise: true,
      },
    ],
  };
}
function inputs(
  intent = request,
  placements = [placement(), placement(32, id(7), id(8))],
  oldSkus = [id(6), id(7)],
) {
  const menuRequest = {
    purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ" as const,
    brandReference: intent.brandReference,
    actorReference: intent.actorReference,
    operationReference: intent.operationReference,
    catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(intent)),
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
    menuSource: buildMenuReferenceSourceSnapshot(menuRaw(placements), menuRequest, at),
    now: at,
  };
}
const denied = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
describe("held exact Product graph to Menu placement membership", () => {
  it("retains each graph separately with Superseded lifecycle and historical Published release/future period", () => {
    const v = inputs(),
      r = matchProductMenuReferences(v),
      old = r.recorded.find((c) => c.configuration.versionReference === id(8));
    expect(
      r.current.references.flatMap((c) => c.placements.map((p) => p.placementReference)),
    ).toEqual([id(31)]);
    expect(old?.references.flatMap((c) => c.placements.map((p) => p.placementReference))).toEqual([
      id(32),
    ]);
    expect(r.current.references[0]).toMatchObject({
      lifecycle: { state: "Superseded", version: 4 },
      revisions: [{ state: "Published" }, { state: "Superseded" }],
      releases: [{ releaseReference: id(50), lifecycleVersion: 3 }],
      periods: [{ effectiveFrom: "2027-01-01T00:00:00.000Z" }],
    });
    expect(r.unresolved).toEqual([]);
    expect(r).toMatchObject({
      coverage: "KnownCurrentAndRecordedDraftGraphs",
      menuReferenceCoverage: "CompleteStoredGraph",
      applicability: "Unavailable",
      publicationCoverage: "Unavailable",
      futureScheduleCoverage: "Unavailable",
      menuGeneration: "7",
      menuSourceDigest: v.menuSource.digest,
    });
    expect(Object.isFrozen(r.current.references[0]?.placements)).toBe(true);
  });
  it("never inherits old-version placement merely because current SKU matches", () => {
    const r = matchProductMenuReferences(inputs(request, [placement(31, id(6), id(8))]));
    expect(r.current.references).toEqual([]);
    expect(
      r.recorded.find((c) => c.configuration.versionReference === id(8))?.references,
    ).toHaveLength(1);
  });
  it("keeps same-version historical configuration membership separate", () => {
    const v = inputs(request, [placement(31, id(7), id(5))]);
    v.catalogHistory = buildProductReferenceHistorySourceSnapshot(
      {
        observedAt: at,
        targetExists: true,
        recordedAggregateVersion: 2,
        recordCoverage: true,
        configurations: [graph(), graph([id(6), id(7)])],
      },
      request,
      at,
    );
    const r = matchProductMenuReferences(v);
    expect(r.current.references).toEqual([]);
    expect(r.unresolved).toEqual([]);
    expect(
      r.recorded.find((c) => c.configuration.skuReferences.includes(id(7)))?.references,
    ).toHaveLength(1);
  });
  it("preserves unresolved known SKU/unknown version and known version/unknown SKU evidence", () => {
    const r = matchProductMenuReferences(
      inputs(request, [
        placement(),
        placement(32, id(6), id(99)),
        placement(33, id(99), id(5)),
        placement(34, id(98), id(97)),
      ]),
    );
    expect(r.current.references[0]?.placements.map((p) => p.placementReference)).toEqual([id(31)]);
    expect(r.unresolved.flatMap((c) => c.placements.map((p) => p.placementReference))).toEqual([
      id(32),
      id(33),
    ]);
  });
  it("does not union other SKU graphs for an absent selected SKU", () => {
    const r = matchProductMenuReferences(
      inputs({ ...request, skuReference: id(6) }, undefined, [id(7)]),
    );
    const old = r.recorded.find((c) => c.configuration.versionReference === id(8));
    expect(old?.targetMembership).toBe("Absent");
    expect(old?.references).toEqual([]);
  });
  it("selected SKU unresolved evidence excludes other SKU placements", () => {
    const r = matchProductMenuReferences(
      inputs({ ...request, skuReference: id(6) }, [
        placement(31, id(6), id(99)),
        placement(32, id(99), id(5)),
      ]),
    );
    expect(r.unresolved.flatMap((c) => c.placements.map((p) => p.placementReference))).toEqual([
      id(31),
    ]);
  });
  it("retains empty reviewed snapshot in source fingerprint and accepts truly empty source without publication inference", () => {
    const v = inputs(request, []),
      r = matchProductMenuReferences(v);
    expect(v.menuSource.reviews).toHaveLength(2);
    expect(r.current.references).toEqual([]);
    expect(r.menuSourceDigest).toBe(v.menuSource.digest);
    const raw = {
      generation: null,
      observedAt: at,
      counts: { reviews: "0", placements: "0", revisions: "0", releases: "0", periods: "0" },
      reviews: [],
      placements: [],
      revisions: [],
      releases: [],
      periods: [],
    };
    const empty = matchProductMenuReferences({
      ...v,
      menuSource: buildMenuReferenceSourceSnapshot(raw, v.menuSource.request, at),
    });
    expect(empty.unresolved).toEqual([]);
    expect(empty.publicationCoverage).toBe("Unavailable");
  });
  it("keeps owning observation provenance independent of stable data digest", () => {
    const v = inputs(),
      a = matchProductMenuReferences(v),
      later = "2026-09-29T12:00:01.000Z",
      raw = menuRaw();
    raw.observedAt = later;
    const b = matchProductMenuReferences({
      ...v,
      menuSource: buildMenuReferenceSourceSnapshot(raw, v.menuSource.request, later),
      now: later,
    });
    expect(b.digest).toBe(a.digest);
    expect(b.observations).toEqual({ catalogCurrent: at, catalogHistory: at, menu: later });
    expect(b.observedAt).toBe(at);
  });
  it.each([
    "operation",
    "version",
    "reason",
    "target",
    "digest",
    "generation",
    "partial",
    "stale",
    "historyRevision",
    "graph",
  ])("refuses changed %s context", (kind) => {
    const v = inputs();
    if (kind === "operation") v.request = { ...request, operationReference: id(70) };
    if (kind === "version") v.request = { ...request, expectedAggregateVersion: 3 };
    if (kind === "reason") v.request = { ...request, reasonCode: "DIFFERENT" };
    if (kind === "target") v.request = { ...request, skuReference: id(7) };
    if (kind === "digest") v.menuSource = { ...v.menuSource, digest: "sha256:" + "b".repeat(64) };
    if (kind === "generation") v.menuSource = { ...v.menuSource, generation: "8" };
    if (kind === "partial")
      Object.assign((v.menuSource = { ...v.menuSource }), { coverage: "Partial" });
    if (kind === "stale") v.now = "2026-09-29T12:00:05.001Z";
    if (kind === "historyRevision")
      v.catalogHistory = { ...v.catalogHistory, recordedAggregateVersion: 3 };
    if (kind === "graph")
      v.catalogCurrent = buildProductPricingBindingSourceSnapshot(
        { observedAt: at, targetExists: true, precise: true, ...graph([id(6), id(9)]) },
        request,
        at,
      );
    expect(() => matchProductMenuReferences(v)).toThrow(denied);
  });
  it("rejects executable DTOs without invoking getters", () => {
    const v = inputs(),
      getter = vi.fn(() => []);
    Object.defineProperty((v.menuSource = { ...v.menuSource }), "placements", {
      enumerable: true,
      get: getter,
    });
    expect(() => matchProductMenuReferences(v)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
  });
  it("fails aggregate expanded publication histories instead of truncating references", () => {
    const v = inputs(
      request,
      Array.from({ length: 6000 }, (_, i) => placement(1000 + i)),
    );
    expect(() => matchProductMenuReferences(v)).toThrow(denied);
  });
});
