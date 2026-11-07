import { describe, it, expect } from "vitest";
import { matchRecipeInventoryReferenceRoots } from "@rms/recipe";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildProductPricingBindingSourceSnapshot,
  buildProductReferenceHistorySourceSnapshot,
  type ProductLifecycleReviewRequest,
} from "@rms/catalog";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchRaw,
  recipeMatchSource,
} from "../../../packages/rms/recipe/src/tests/recipe-catalog-reference-matches.fixture.js";
import {
  recipeInventoryMatchRaw,
  recipeInventoryMatchSource,
  recipeInventoryItemId as item,
} from "../../../packages/rms/recipe/src/tests/recipe-inventory-reference-matches.fixture.js";
import { mappingMatchSource } from "../../../packages/rms/inventory/src/tests/sku-mapping-reference-matches.fixture.js";
import { composeMerchantProductRecipeInventoryReferenceMatches as compose } from "./merchant-product-recipe-inventory-reference-matches.js";
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
function inputs(
  intent = request,
  now = at,
  ingredients = recipeInventoryMatchRaw(),
  bindings = recipeMatchRaw(),
) {
  const common = {
    brandReference: intent.brandReference,
    actorReference: intent.actorReference,
    operationReference: intent.operationReference,
    catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(intent)),
  };
  ingredients.observedAt = now;
  bindings.observedAt = now;
  return {
    tenantReference: item(1),
    request: intent,
    now,
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
    recipeSource: recipeMatchSource(
      { purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ", ...common },
      bindings,
      now,
    ),
    recipeInventorySource: recipeInventoryMatchSource(
      { purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ", ...common },
      ingredients,
      now,
    ),
    inventorySource: mappingMatchSource(
      {
        purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
        tenantReference: item(1),
        ...common,
      },
      undefined,
      false,
      now,
    ),
  };
}
const unavailable = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
describe("Product Recipe to recorded Inventory configuration composition", () => {
  it("joins pinned operation UUID to historical numeric Item version, not current version", () => {
    const result = compose(inputs()),
      base = result.current.inventoryReferences.find(
        (r) => r.requirement.kind === "BaseIngredient" && !r.requirement.conditional,
      );
    expect(base?.resolution).toMatchObject({
      state: "ResolvedStoredConfiguration",
      item: { itemReference: item(6), currentItemVersion: 2 },
      operation: { operationReference: item(7), itemVersion: 1 },
      version: { itemVersion: 1 },
      isCurrentItemConfiguration: false,
    });
  });
  it("retains conditional current Item and cyclic replacement separately from unresolved removal", () => {
    const result = compose(inputs());
    expect(
      result.current.inventoryReferences.find((r) => r.requirement.kind === "ModifierAdd")
        ?.resolution,
    ).toMatchObject({
      state: "ResolvedStoredConfiguration",
      item: { itemReference: item(20) },
      isCurrentItemConfiguration: true,
    });
    expect(
      result.current.recipeReachability.requirements.find((r) => r.kind === "ModifierReplace"),
    ).toMatchObject({ conditional: true, modifier: { lifecycle: "Archived" } });
    expect(
      result.current.recipeReachability.requirements.find((r) => r.kind === "ModifierRemove"),
    ).toMatchObject({ conditional: true });
    expect(result.removalResolution).toBe("Unavailable");
    expect(result.conditionalApplicability).toBe("Unavailable");
  });
  it("keeps independent current and recorded Catalog root context", () => {
    const result = compose(inputs()),
      current = result.current.rootContexts.find((r) => r.recipeVersionReference === id(12)),
      past = result.recorded[1]?.matches.rootContexts.find(
        (r) => r.recipeVersionReference === id(12),
      );
    expect(current?.unresolvedBindings.length).toBeGreaterThan(0);
    expect(past?.matchedBindingReferences).toContain(id(61));
    expect(result.current.catalogConfigurationDigest).toBe(
      result.recorded[0]?.matches.catalogConfigurationDigest,
    );
    expect(result.current.catalogConfigurationDigest).not.toBe(
      result.recorded[1]?.matches.catalogConfigurationDigest,
    );
    expect(
      result.current.inventoryReferences.some(
        (r) => r.requirement.rootRecipeVersionReference === id(11),
      ),
    ).toBe(true);
  });
  it.each(["item", "operation", "wrongItem"])("keeps missing or wrong %s explicit", (kind) => {
    const raw = recipeInventoryMatchRaw(),
      requirement = raw.ingredients[1];
    if (!requirement) throw new Error("Fixture absent");
    if (kind === "item") requirement.sourceReference = item(99);
    if (kind === "operation") requirement.sourceVersionReference = item(99);
    if (kind === "wrongItem") requirement.sourceVersionReference = item(27);
    const result = compose(inputs(request, at, raw)),
      reference = result.current.inventoryReferences.find(
        (r) => r.requirement.kind === "BaseIngredient" && !r.requirement.conditional,
      );
    expect(reference?.resolution).toEqual({
      state: "Unresolved",
      reason:
        kind === "item"
          ? "InventoryItemNotRecorded"
          : kind === "operation"
            ? "InventoryOperationNotRecorded"
            : "InventoryOperationItemMismatch",
    });
  });
  it.each(["generation", "root", "version", "modifier"])(
    "refuses independent source %s drift even with valid owning digests",
    (kind) => {
      const raw = recipeInventoryMatchRaw();
      if (kind === "generation") raw.generation = "8";
      if (kind === "root") {
        const r = raw.recipes[0];
        if (!r) throw new Error("Fixture absent");
        r.aggregateVersion = 4;
      }
      if (kind === "version") {
        const v = raw.versions[0];
        if (!v) throw new Error("Fixture absent");
        v.snapshotDigest = "sha256:" + "b".repeat(64);
      }
      if (kind === "modifier") {
        const m = raw.modifiers[0];
        if (!m) throw new Error("Fixture absent");
        m.ruleDigest = "sha256:" + "b".repeat(64);
      }
      expect(() => compose(inputs(request, at, raw))).toThrow(unavailable);
    },
  );
  it.each(["tenant", "intent", "recipe", "inventory", "time"])("refuses substituted %s", (kind) => {
    const value = inputs();
    if (kind === "tenant") value.tenantReference = item(99);
    if (kind === "intent") value.request = { ...request, operationReference: id(99) };
    if (kind === "recipe")
      value.recipeInventorySource = {
        ...value.recipeInventorySource,
        digest: "sha256:" + "f".repeat(64),
      };
    if (kind === "inventory")
      value.inventorySource = { ...value.inventorySource, digest: "sha256:" + "f".repeat(64) };
    if (kind === "time") value.now = "2026-09-29T12:00:06.000Z";
    expect(() => compose(value)).toThrow(unavailable);
  });
  it("bounds combined cross-source output even when individual sources and rooted traversals fit", () => {
    const value = inputs();
    value.catalogHistory = buildProductReferenceHistorySourceSnapshot(
      {
        observedAt: at,
        targetExists: true,
        recordedAggregateVersion: 2,
        recordCoverage: true,
        configurations: Array.from({ length: 220 }, (_, i) => graph(6, 80 + i)),
      },
      request,
      at,
    );
    expect(
      matchRecipeInventoryReferenceRoots({
        request: value.recipeInventorySource.request,
        source: value.recipeInventorySource,
        rootGroups: Array.from({ length: 221 }, () => [id(11), id(12)]),
        now: at,
      }),
    ).toHaveLength(221);
    expect(() => compose(value)).toThrow(unavailable);
  });
  it("excludes new observation time from identity and rich quantity/health details from output", () => {
    const a = compose(inputs()),
      b = compose(inputs(request, "2026-09-29T12:00:01.000Z"));
    expect(a.digest).toBe(b.digest);
    expect(JSON.stringify(a)).not.toMatch(
      /selectedQuantity|quantity|cost|allergen|snapshot_json|audit_json|stock/,
    );
    expect(a.applicability).toBe("Unavailable");
    expect(a.publicationCoverage).toBe("Unavailable");
    expect(a.futureScheduleCoverage).toBe("Unavailable");
    expect(Object.isFrozen(a.current.inventoryReferences)).toBe(true);
  });
});
