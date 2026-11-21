import { describe, it, expect } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildProductPricingBindingSourceSnapshot,
  buildProductReferenceHistorySourceSnapshot,
  type ProductLifecycleReviewRequest,
} from "@rms/catalog";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchSource,
  recipeMatchRaw,
} from "../../../packages/rms/recipe/src/tests/recipe-catalog-reference-matches.fixture.js";
import { composeMerchantProductRecipeReferenceMatches as compose } from "./merchant-product-recipe-reference-matches.js";
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
function graph(sku = 6, option = 80) {
  return {
    versionReference: id(5),
    categoryClassificationKnown: false,
    categoryReferences: null,
    primaryCategoryReference: null,
    taxClassificationReference: null,
    skuReferences: [id(sku)],
    bindings: [
      {
        bindingReference: id(20),
        optionSetReference: id(70),
        optionSetVersionReference: id(71),
        enabledOptionReferences: [id(option)],
        includedSkuReferences: [id(sku)],
        excludedSkuReferences: [],
        channelCodes: [],
      },
    ],
  };
}
function inputs(intent = request, now = at) {
  const recipeRequest = {
      purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const,
      brandReference: intent.brandReference,
      actorReference: intent.actorReference,
      operationReference: intent.operationReference,
      catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(intent)),
    },
    raw = recipeMatchRaw();
  raw.observedAt = now;
  return {
    request: intent,
    catalogCurrent: buildProductPricingBindingSourceSnapshot(
      { observedAt: now, targetExists: true, precise: true, ...graph() },
      intent,
      now,
    ),
    catalogHistory: buildProductReferenceHistorySourceSnapshot(
      {
        observedAt: now,
        targetExists: true,
        recordedAggregateVersion: 2,
        recordCoverage: true,
        configurations: [graph(), graph(7, 81)],
      },
      intent,
      now,
    ),
    recipeSource: recipeMatchSource(recipeRequest, raw, now),
    now,
  };
}
const denied = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
describe("validated public current/recorded Product Recipe composition", () => {
  it("keeps same Product Version configurations separate with independent SKU/Option history", () => {
    const r = compose(inputs()),
      old = r.recorded.find((c) => c.configuration.skuReferences.includes(id(7)));
    expect(r.current.references[0]?.modifiers.map((m) => m.reference.optionReference)).toEqual([
      id(80),
      id(80),
    ]);
    expect(old?.matches.references[0]?.modifiers.map((m) => m.reference.optionReference)).toEqual([
      id(81),
    ]);
    expect(old?.configuration.versionReference).toBe(r.current.target.versionReference);
    expect(r).toMatchObject({
      coverage: "KnownCurrentAndRecordedDraftGraphs",
      publicationCoverage: "Unavailable",
      futureScheduleCoverage: "Unavailable",
      applicability: "Unavailable",
      recipeGeneration: "7",
    });
  });
  it("keeps selected new SKU absent from older configuration with empty refs", () => {
    const r = compose(inputs({ ...request, skuReference: id(6) })),
      old = r.recorded.find((c) => c.configuration.skuReferences.includes(id(7)));
    expect(r.current.targetMembership).toBe("Present");
    expect(old?.matches.targetMembership).toBe("Absent");
    expect(old?.matches.references).toEqual([]);
    expect(old?.matches.unresolved).toEqual([]);
  });
  it("keeps stable composition digest separate from all actual observation times", () => {
    const a = compose(inputs()),
      later = "2026-09-29T12:00:01.000Z",
      b = compose(inputs(request, later));
    expect(b.digest).toBe(a.digest);
    expect(b.observations).toEqual({ catalogCurrent: later, catalogHistory: later, recipe: later });
    expect(b.observedAt).toBe(later);
  });
  it.each(["intent", "pair", "source", "time"])(
    "rejects %s before claiming source match",
    (kind) => {
      const r = inputs();
      if (kind === "intent") r.request = { ...request, operationReference: id(9) };
      if (kind === "pair") r.catalogHistory = { ...r.catalogHistory, recordedAggregateVersion: 3 };
      if (kind === "source")
        r.recipeSource = { ...r.recipeSource, digest: "sha256:" + "b".repeat(64) };
      if (kind === "time") r.now = "2026-09-29T12:00:05.001Z";
      expect(() => compose(r)).toThrow(denied);
    },
  );
});
