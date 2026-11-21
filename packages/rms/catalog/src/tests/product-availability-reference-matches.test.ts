import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildProductPricingBindingSourceSnapshot,
  buildProductReferenceHistorySourceSnapshot,
  buildAvailabilityReferenceSourceSnapshot,
  matchProductAvailabilityReferences,
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
function rule(n: number, type = "Product", reference = id(3)) {
  return {
    ruleReference: id(n),
    brandReference: id(1),
    sellableType: type,
    sellableReference: reference,
    storeReference: id(90),
    aggregateVersion: 1,
    lifecycle: "Inactive",
    effectiveFrom: "2027-01-01T00:00:00.000Z",
    effectiveUntil: null,
    updatedAt: at,
    precise: true,
  };
}
function inputs(
  intent = request,
  rules = [
    rule(10),
    rule(11, "Sku", id(6)),
    rule(12, "Sku", id(7)),
    rule(13, "Bundle", id(30)),
    rule(14, "Sku", id(99)),
    rule(15, "Product", id(40)),
  ],
  oldSkus = [id(6), id(7)],
) {
  const catalogCurrent = buildProductPricingBindingSourceSnapshot(
      { observedAt: at, targetExists: true, precise: true, ...graph() },
      intent,
      at,
    ),
    catalogHistory = buildProductReferenceHistorySourceSnapshot(
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
    availabilitySource = buildAvailabilityReferenceSourceSnapshot(
      { generation: "7", rootCount: String(rules.length), observedAt: at, rules },
      {
        purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ",
        brandReference: intent.brandReference,
        actorReference: intent.actorReference,
        operationReference: intent.operationReference,
        catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(intent)),
      },
      at,
    );
  return { request: intent, catalogCurrent, catalogHistory, availabilitySource, now: at };
}
const denied = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
describe("exact current and recorded Availability reference graphs", () => {
  it("keeps removed SKU only in each applicable historical configuration and preserves unknown/future/Store facts", () => {
    const input = inputs(),
      result = matchProductAvailabilityReferences(input);
    expect(result.current.references.map((r) => r.ruleReference)).toEqual([id(10), id(11)]);
    expect(
      result.recorded
        .find((c) => c.configuration.skuReferences.includes(id(7)))
        ?.references.map((r) => r.ruleReference),
    ).toEqual([id(10), id(11), id(12)]);
    expect(
      result.recorded
        .find((c) => c.configuration.versionReference === id(5))
        ?.references.map((r) => r.ruleReference),
    ).toEqual([id(10), id(11)]);
    expect(
      result.recorded.every(
        (c) =>
          c.configuration.categoryReferences === null &&
          c.configuration.taxClassificationReference === null,
      ),
    ).toBe(true);
    expect(result).toMatchObject({
      availabilityGeneration: "7",
      availabilitySourceDigest: input.availabilitySource.digest,
      applicability: "Unavailable",
      indirectBundleCoverage: "Unavailable",
      publicationCoverage: "Unavailable",
      futureScheduleCoverage: "Unavailable",
    });
    expect(result.current.references[0]).toMatchObject({
      storeReference: id(90),
      effectiveFrom: "2027-01-01T00:00:00.000Z",
      lifecycle: "Inactive",
    });
    expect(Object.isFrozen(result.recorded[0]?.references)).toBe(true);
    expect(matchProductAvailabilityReferences(input).digest).toBe(result.digest);
  });
  it("retains actual observation provenance while data fingerprints remain stable", () => {
    const value = inputs(),
      first = matchProductAvailabilityReferences(value),
      later = "2026-09-29T12:00:01.000Z";
    const source = buildAvailabilityReferenceSourceSnapshot(
      {
        generation: value.availabilitySource.generation,
        rootCount: "6",
        observedAt: later,
        rules: value.availabilitySource.rules.map((r) => ({ ...r, precise: true })),
      },
      value.availabilitySource.request,
      later,
    );
    const result = matchProductAvailabilityReferences({
      ...value,
      availabilitySource: source,
      now: later,
    });
    expect(result.observations).toEqual({
      catalogCurrent: at,
      catalogHistory: at,
      availability: later,
    });
    expect(result.observedAt).toBe(at);
    expect(result.digest).toBe(first.digest);
  });
  it("does not union other SKU graphs when selected SKU was absent from a recorded configuration", () => {
    const result = matchProductAvailabilityReferences(
      inputs({ ...request, skuReference: id(6) }, undefined, [id(7)]),
    );
    expect(result.current.references.map((r) => r.ruleReference)).toEqual([id(10), id(11)]);
    const absent = result.recorded.find((c) => !c.configuration.skuReferences.includes(id(6)));
    expect(absent?.targetMembership).toBe("Absent");
    expect(absent?.references).toEqual([]);
  });
  it("accepts complete empty data without pretending indirect Bundle or publication coverage", () => {
    const result = matchProductAvailabilityReferences(inputs(request, []));
    expect(result.current.references).toEqual([]);
    expect(result.recorded.every((c) => c.references.length === 0)).toBe(true);
    expect(result.indirectBundleCoverage).toBe("Unavailable");
  });
  it.each([
    "operation",
    "expectedVersion",
    "reason",
    "target",
    "sourceDigest",
    "generation",
    "partial",
    "stale",
    "historyRevision",
    "graph",
  ])("rejects changed %s context", (kind) => {
    const value = inputs();
    if (kind === "operation") value.request = { ...request, operationReference: id(70) };
    if (kind === "expectedVersion") value.request = { ...request, expectedAggregateVersion: 3 };
    if (kind === "reason") value.request = { ...request, reasonCode: "DIFFERENT" };
    if (kind === "target") value.request = { ...request, skuReference: id(7) };
    if (kind === "sourceDigest")
      value.availabilitySource = {
        ...value.availabilitySource,
        digest: "sha256:" + "b".repeat(64),
      };
    if (kind === "generation")
      value.availabilitySource = { ...value.availabilitySource, generation: "8" };
    if (kind === "partial")
      Object.assign((value.availabilitySource = { ...value.availabilitySource }), {
        coverage: "Partial",
      });
    if (kind === "stale") value.now = "2026-09-29T12:00:05.001Z";
    if (kind === "historyRevision")
      value.catalogHistory = { ...value.catalogHistory, recordedAggregateVersion: 3 };
    if (kind === "graph")
      value.catalogCurrent = buildProductPricingBindingSourceSnapshot(
        { observedAt: at, targetExists: true, precise: true, ...graph([id(6), id(9)]) },
        request,
        at,
      );
    expect(() => matchProductAvailabilityReferences(value)).toThrow(denied);
  });
  it("rejects executable DTOs without invoking accessors", () => {
    const value = inputs(),
      getter = vi.fn(() => []);
    Object.defineProperty((value.availabilitySource = { ...value.availabilitySource }), "rules", {
      enumerable: true,
      get: getter,
    });
    expect(() => matchProductAvailabilityReferences(value)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
  });
  it("fails instead of truncating repeated historical match output beyond the defensive bound", () => {
    const value = inputs(
      request,
      Array.from({ length: 4000 }, (_, i) => rule(100 + i)),
    );
    expect(() => matchProductAvailabilityReferences(value)).toThrow(denied);
  });
});
