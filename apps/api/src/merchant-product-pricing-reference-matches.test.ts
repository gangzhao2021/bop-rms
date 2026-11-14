import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildProductPricingBindingSourceSnapshot,
  buildProductReferenceHistorySourceSnapshot,
} from "@rms/catalog";
import { buildConfigurationReferenceSourceSnapshot } from "@rms/pricing";
import {
  fixture,
  id,
  at,
} from "../../../packages/rms/pricing/src/tests/configuration-reference-matches.fixture.js";
import {
  composeMerchantProductPricingReferenceMatches as compose,
  composeMerchantProductRecordedPricingReferenceMatches as composeHistory,
  composeMerchantProductPricingReferenceSourceMatches as composeSource,
} from "./merchant-product-pricing-reference-matches.js";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_REVIEW" as const,
  brandReference: id(1),
  actorReference: id(2),
  productReference: id(10),
  skuReference: null,
  operationReference: id(3),
  expectedAggregateVersion: 1,
  originalProductVersionReference: id(15),
  beforeLifecycle: "Draft" as const,
  targetLifecycle: "Archived" as const,
  reasonCode: "REVIEW",
  activeSkuCount: 0,
};
function inputs(value = request) {
  const f = fixture({
    purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
    brandReference: value.brandReference,
    actorReference: value.actorReference,
    operationReference: value.operationReference,
    catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  });
  const catalog = buildProductPricingBindingSourceSnapshot(
    {
      observedAt: at,
      targetExists: true,
      precise: true,
      versionReference: id(15),
      categoryClassificationKnown: true,
      categoryReferences: [id(13)],
      primaryCategoryReference: id(13),
      taxClassificationReference: null,
      skuReferences: f.target.skuReferences,
      bindings: f.target.bindings.map((b) => ({
        ...b,
        optionSetReference: id(30),
        optionSetVersionReference: id(31),
      })),
    },
    value,
    at,
  );
  return {
    request: value,
    catalog,
    priceBooks: f.priceBooks,
    optionPrices: f.optionPrices,
    promotions: f.promotions,
    now: at,
  };
}
it("composes only validated public sources anchored to exact original Catalog intent", () => {
  const input = inputs(),
    result = compose(input);
  expect(result.request.catalogIntentDigest).toBe(
    "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
  );
  expect(result.catalogSourceDigest).toBe(input.catalog.digest);
  expect(result.priceEntries).toHaveLength(1);
  expect(result.optionRoots).toHaveLength(1);
  expect(result.promotions).toHaveLength(3);
  expect(result.coverage).toBe("CurrentDraftOnly");
});
it("fails unavailable for changed original intent or invalid Catalog/source metadata", () => {
  const input = inputs();
  for (const altered of [
    { ...input, request: { ...request, reasonCode: "CHANGED" } },
    { ...input, catalog: { ...input.catalog, coverage: "Partial" } },
    { ...input, catalog: { ...input.catalog, digest: "sha256:" + "f".repeat(64) } },
    {
      ...input,
      priceBooks: {
        ...input.priceBooks,
        request: { ...input.priceBooks.request, operationReference: id(99) },
      },
    },
  ])
    expect(() => compose(altered)).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
});

function historyInputs(value = request) {
  const input = inputs(value),
    c = input.catalog;
  const graph = {
    versionReference: c.versionReference,
    skuReferences: c.skuReferences,
    categoryClassificationKnown: true,
    categoryReferences: c.categoryReferences,
    primaryCategoryReference: c.primaryCategoryReference,
    taxClassificationReference: c.taxClassificationReference,
    bindings: c.bindings,
  };
  const catalogHistory = buildProductReferenceHistorySourceSnapshot(
    {
      observedAt: at,
      targetExists: true,
      recordedAggregateVersion: 2,
      recordCoverage: true,
      configurations: [
        graph,
        { ...graph, bindings: [], categoryReferences: [], primaryCategoryReference: null },
      ],
    },
    value,
    at,
  );
  return { ...input, catalogHistory };
}
it("composes recorded configurations without merging old/current bindings or claiming full lifecycle review", () => {
  const input = historyInputs(),
    result = composeHistory(input);
  expect(result.catalogSourceDigest).toBe(input.catalogHistory.digest);
  expect(result.request.catalogIntentDigest).toBe(
    "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
  );
  expect(result.configurations).toHaveLength(2);
  expect(result.configurations.some((c) => c.matches?.optionVersions.length === 1)).toBe(true);
  expect(
    result.configurations.some((c) =>
      c.matches?.unresolvedOptionRoots.some(
        (r) => r.reason === "BindingNotInRecordedConfiguration",
      ),
    ),
  ).toBe(true);
  expect(result.publicationCoverage).toBe("Unavailable");
  expect(result.futureScheduleCoverage).toBe("Unavailable");
});
it("rejects altered historical profiles, original intent, source digests and invented publication coverage", () => {
  const input = historyInputs();
  for (const changed of [
    { ...input, request: { ...request, reasonCode: "CHANGED" } },
    { ...input, catalogHistory: { ...input.catalogHistory, digest: "sha256:" + "f".repeat(64) } },
    { ...input, catalogHistory: { ...input.catalogHistory, publicationCoverage: "Complete" } },
    {
      ...input,
      catalogHistory: {
        ...input.catalogHistory,
        configurations: input.catalogHistory.configurations.slice(0, 1),
      },
    },
  ])
    expect(() => composeHistory(changed)).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
});

function sourceInputs() {
  const i = historyInputs({ ...request, expectedAggregateVersion: 2 });
  const pricingSource = buildConfigurationReferenceSourceSnapshot(
    {
      generation: "1",
      priceBooks: i.priceBooks,
      optionPrices: i.optionPrices,
      promotions: i.promotions,
    },
    i.priceBooks.request,
    at,
  );
  return {
    request: i.request,
    catalogCurrent: i.catalog,
    catalogHistory: i.catalogHistory,
    pricingSource,
    now: at,
  };
}
it("composes unified owning source with current and recorded references and preserves generation/unknown publication", () => {
  const input = sourceInputs(),
    result = composeSource(input);
  expect(result.pricingGeneration).toBe("1");
  expect(result.pricingSourceDigest).toBe(input.pricingSource.digest);
  expect(result.current.priceEntries).toHaveLength(1);
  expect(result.recorded.configurations).toHaveLength(2);
  expect(result.recorded.publicationCoverage).toBe("Unavailable");
  expect(result.recorded.futureScheduleCoverage).toBe("Unavailable");
  expect(JSON.stringify(result)).not.toMatch(/Allowed|ApprovalPassed|amountMinor/);
});
it("rejects wrong unified source intent/partial data, mismatched source revision or missing current graph", () => {
  const i = sourceInputs();
  for (const change of [
    { request: { ...i.request, reasonCode: "ALTERED" } },
    { pricingSource: { ...i.pricingSource, coverage: "Partial" } },
    { pricingSource: { ...i.pricingSource, generation: "2" } },
    { catalogCurrent: { ...i.catalogCurrent, digest: "sha256:" + "f".repeat(64) } },
    { catalogHistory: { ...i.catalogHistory, recordedAggregateVersion: 3 } },
  ])
    expect(() => composeSource({ ...i, ...change })).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
});
