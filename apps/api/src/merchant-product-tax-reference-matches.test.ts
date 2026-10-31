import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildProductPricingBindingSourceSnapshot,
  buildProductReferenceHistorySourceSnapshot,
} from "@rms/catalog";
import {
  fixture,
  id,
  at,
} from "../../../packages/rms/pricing/src/tests/tax-classification-reference-matches.fixture.js";
import { composeMerchantProductTaxReferenceMatches as compose } from "./merchant-product-tax-reference-matches.js";
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
function inputs() {
  const f = fixture({
    purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
    brandReference: request.brandReference,
    actorReference: request.actorReference,
    operationReference: request.operationReference,
    catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
    storeReference: id(9),
  });
  const graph = {
    versionReference: id(15),
    skuReferences: [id(11), id(12)],
    categoryClassificationKnown: true,
    categoryReferences: [],
    primaryCategoryReference: null,
    taxClassificationReference: id(11),
    bindings: [],
  };
  const current = buildProductPricingBindingSourceSnapshot(
    { observedAt: at, targetExists: true, precise: true, ...graph },
    request,
    at,
  );
  const history = buildProductReferenceHistorySourceSnapshot(
    {
      observedAt: at,
      targetExists: true,
      recordedAggregateVersion: 2,
      recordCoverage: true,
      configurations: [graph, { ...graph, taxClassificationReference: null }],
    },
    request,
    at,
  );
  return {
    request,
    storeReference: id(9),
    taxConfigurations: f.taxConfigurations,
    now: at,
    current,
    history,
  };
}
it("composes current and historical Product Version classification facts with exact Store and original intent", () => {
  const f = inputs(),
    r = compose({ ...f, sourceProfile: "CurrentDraftBindings", catalogSource: f.current });
  expect(r.classificationCoverage).toBe("CompleteExplicit");
  expect(r.configurations[0]?.references).toHaveLength(1);
  const history = compose({
    ...f,
    sourceProfile: "RecordedDraftConfigurations",
    catalogSource: f.history,
  });
  expect(history.classificationCoverage).toBe("DefaultUnavailable");
  expect(history.configurations).toHaveLength(2);
  expect(history.crossStoreCoverage).toBe("Unavailable");
  expect(history.skuTaxOverrideCoverage).toBe("Unavailable");
});
it("fails unavailable for altered Actor/intent/Store/coverage/digest rather than authorizing caller scope", () => {
  const f = inputs(),
    input = { ...f, sourceProfile: "CurrentDraftBindings" as const, catalogSource: f.current };
  for (const changed of [
    { ...input, storeReference: id(99) },
    { ...input, request: { ...request, reasonCode: "CHANGED" } },
    { ...input, request: { ...request, actorReference: id(99) } },
    { ...input, catalogSource: { ...f.current, coverage: "Partial" } },
    { ...input, taxConfigurations: { ...f.taxConfigurations, digest: "sha256:" + "f".repeat(64) } },
  ])
    expect(() => compose(changed)).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
});

it("projects current/history Catalog facts into complete Brand Tax matches without a caller Store list", async () => {
  const { brandFixture } =
    await import("../../../packages/rms/pricing/src/tests/brand-tax-classification-reference-matches.fixture.js");
  const { composeMerchantProductBrandTaxReferenceMatches: brandCompose } =
    await import("./merchant-product-tax-reference-matches.js");
  const f = inputs(),
    b = brandFixture({
      purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
      brandReference: request.brandReference,
      actorReference: request.actorReference,
      operationReference: request.operationReference,
      catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
    });
  const r = brandCompose({
    request,
    sourceProfile: "CurrentDraftBindings",
    catalogSource: f.current,
    taxConfigurations: b.taxConfigurations,
    now: at,
  });
  expect(r.configurations[0]?.references).toHaveLength(2);
  expect(r.unresolvedRoots).toHaveLength(1);
  expect(r.retiredRootReferences).toHaveLength(1);
  const h = brandCompose({
    request,
    sourceProfile: "RecordedDraftConfigurations",
    catalogSource: f.history,
    taxConfigurations: b.taxConfigurations,
    now: at,
  });
  expect(h.classificationCoverage).toBe("DefaultUnavailable");
  expect(h.crossStoreCoverage).toBe("CompleteRegisteredReferences");
  expect(() =>
    brandCompose({
      request: { ...request, reasonCode: "ALTERED" },
      sourceProfile: "CurrentDraftBindings",
      catalogSource: f.current,
      taxConfigurations: b.taxConfigurations,
      now: at,
    }),
  ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
});
