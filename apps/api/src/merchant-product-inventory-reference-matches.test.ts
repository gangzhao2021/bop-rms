import { describe, it, expect } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildProductPricingBindingSourceSnapshot,
  buildProductReferenceHistorySourceSnapshot,
  type ProductLifecycleReviewRequest,
} from "@rms/catalog";
import {
  mappingMatchId as id,
  mappingMatchAt as at,
  mappingMatchSource as source,
} from "../../../packages/rms/inventory/src/tests/sku-mapping-reference-matches.fixture.js";
import { composeMerchantProductInventoryReferenceMatches as compose } from "./merchant-product-inventory-reference-matches.js";
const request: ProductLifecycleReviewRequest = {
  purposeCode: "CATALOG_LIFECYCLE_REVIEW",
  brandReference: id(2),
  actorReference: id(3),
  productReference: id(8),
  skuReference: null,
  operationReference: id(4),
  expectedAggregateVersion: 2,
  originalProductVersionReference: id(9),
  beforeLifecycle: "Draft",
  targetLifecycle: "Archived",
  reasonCode: "SYNTHETIC",
  activeSkuCount: 0,
};
function graph(sku = 10) {
  return {
    versionReference: id(9),
    categoryClassificationKnown: false,
    categoryReferences: null,
    primaryCategoryReference: null,
    taxClassificationReference: null,
    skuReferences: [id(sku)],
    bindings: [],
  };
}
function inputs(r = request, now = at) {
  const history = buildProductReferenceHistorySourceSnapshot(
      {
        observedAt: now,
        targetExists: true,
        recordedAggregateVersion: 2,
        recordCoverage: true,
        configurations: [graph(), graph(11)],
      },
      r,
      now,
    ),
    config = history.configurations[0];
  if (!config) throw new Error("Fixture absent");
  const digest = "sha256:" + sha256Hex(canonicalizeRfc8785(config)),
    inventoryRequest = {
      purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
      tenantReference: id(1),
      brandReference: r.brandReference,
      actorReference: r.actorReference,
      operationReference: r.operationReference,
      catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(r)),
    };
  return {
    tenantReference: id(1),
    request: r,
    catalogCurrent: buildProductPricingBindingSourceSnapshot(
      {
        observedAt: now,
        targetExists: true,
        precise: true,
        ...graph(r.skuReference === id(11) ? 11 : 10),
      },
      r,
      now,
    ),
    catalogHistory: history,
    inventorySource: source(inventoryRequest, digest, false, now),
    now,
  };
}
const failed = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
describe("Product current and recorded direct Inventory mapping assembly", () => {
  it("uses canonical seven-field identity for current and each independent recorded graph", () => {
    const result = compose(inputs());
    expect(result.current.references[0]?.configurationMatch).toBe("Matched");
    expect(result.recorded[0]?.matches.references[0]?.configurationMatch).toBe("Matched");
    expect(result.recorded[1]?.matches.references[0]?.gaps).toEqual([
      "SkuNotInConfiguration",
      "ConfigurationDigestChanged",
    ]);
    expect(result.current.target.catalogConfigurationDigest).toBe(
      result.recorded[0]?.matches.target.catalogConfigurationDigest,
    );
    expect(result.current.references[0]?.mapping.sourceConfigurationState).toBe("Historical");
    expect(result.publicationCoverage).toBe("Unavailable");
    expect(result.futureScheduleCoverage).toBe("Unavailable");
    expect(result.applicability).toBe("Unavailable");
  });
  it("metadata changes do not alter configuration identity but bind the new intent", () => {
    const a = compose(inputs()),
      b = compose(inputs({ ...request, operationReference: id(99), reasonCode: "OTHER" }));
    expect(a.current.target.catalogConfigurationDigest).toBe(
      b.current.target.catalogConfigurationDigest,
    );
    expect(a.digest).not.toBe(b.digest);
  });
  it("retains selected-SKU mismatch independently from never-recorded coverage", () => {
    const result = compose(inputs({ ...request, skuReference: id(11) }));
    expect(result.current.references).toHaveLength(0);
    expect(result.current.unresolvedItemCoverage[0]?.currentLink).toBe("Unknown");
  });
  it("stable identity excludes observation and reports oldest source time", () => {
    const a = compose(inputs()),
      b = compose(inputs(request, "2026-09-29T12:00:01.000Z"));
    expect(a.digest).toBe(b.digest);
    expect(b.observedAt).toBe("2026-09-29T12:00:01.000Z");
  });
  it.each(["tenant", "intent", "source", "catalog", "time"])("refuses substituted %s", (kind) => {
    const value = inputs();
    if (kind === "tenant") value.tenantReference = id(99);
    if (kind === "intent") value.request = { ...request, operationReference: id(99) };
    if (kind === "source")
      value.inventorySource = { ...value.inventorySource, digest: "sha256:" + "f".repeat(64) };
    if (kind === "catalog")
      value.catalogCurrent = { ...value.catalogCurrent, digest: "sha256:" + "f".repeat(64) };
    if (kind === "time") value.now = "2026-09-29T12:00:06.000Z";
    expect(() => compose(value)).toThrow(failed);
  });
});
