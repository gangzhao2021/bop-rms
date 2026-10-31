import { describe, expect, it, vi } from "vitest";
import {
  parseRecipeProductPublicationReferenceRequestV2,
  parseRecipeInventoryProductPublicationReferenceRequestV2,
  buildRecipeProductPublicationReferenceSnapshotV2,
  buildRecipeInventoryProductPublicationReferenceSnapshotV2,
  matchRecipeProductPublicationReferenceGraphsV2,
  matchRecipeInventoryProductPublicationReferenceRootsV2,
  matchRecipeCatalogReferenceGraphs,
  matchRecipeInventoryReferenceRoots,
  type RecipeProductPublicationReferenceTargetV2,
} from "../index.js";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchDigest as digest,
  recipeMatchRaw,
  recipeMatchTarget,
  recipeMatchRequest,
  recipeMatchSource,
} from "./recipe-catalog-reference-matches.fixture.js";
import {
  recipeInventoryMatchRaw,
  recipeInventoryMatchSource,
} from "./recipe-inventory-reference-matches.fixture.js";
const denied = expect.objectContaining({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
const plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const common = {
  tenantReference: id(99),
  brandReference: id(1),
  actorReference: id(2),
  actorKind: "User" as const,
  operationReference: id(4),
  productReference: id(3),
  versionReference: id(5),
  originalIntentDigest: digest,
  replacementIntentDigest: digest,
  aggregateSnapshotDigest: digest,
  currentPublicationDigest: null,
  observedAt: at,
  validUntil: plus(5000),
};
const request = parseRecipeProductPublicationReferenceRequestV2({
  profile: "RecipeProductPublicationReferenceRequestV2",
  purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ",
  ...common,
});
const inventoryRequest = parseRecipeInventoryProductPublicationReferenceRequestV2({
  profile: "RecipeInventoryProductPublicationReferenceRequestV2",
  purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_INVENTORY_SOURCE_READ",
  ...common,
});
const target = (sku = 6, option = 80): RecipeProductPublicationReferenceTargetV2 => ({
  ...recipeMatchTarget(sku, option),
  mappingProfile: "KnownProductConfigurationV2",
});
const source = () =>
  buildRecipeProductPublicationReferenceSnapshotV2(recipeMatchRaw(), request, at);
const recursive = () =>
  buildRecipeInventoryProductPublicationReferenceSnapshotV2(
    recipeInventoryMatchRaw(),
    inventoryRequest,
    at,
  );
const input = () => ({ request, source: source(), targets: [target()], now: at });
const rootsInput = () => ({
  request: inventoryRequest,
  source: recursive(),
  rootGroups: [[id(11)]],
  now: at,
});

describe("Recipe fixed publication reference matching", () => {
  it("matches current and historical Product graphs independently and retains unresolved Recipe references", () => {
    const matches = matchRecipeProductPublicationReferenceGraphsV2({
      ...input(),
      targets: [target(), { ...target(7, 81), versionReference: id(500) }],
    });
    expect(matches).toHaveLength(2);
    expect(matches[0]?.request).toEqual(request);
    expect(matches[0]?.coverage).toBe("KnownProductConfigurationGraph");
    expect(matches[0]?.references[0]?.bindings[0]?.storeReference).toBe(id(99));
    expect(matches[0]?.references[0]?.modifiers.map((m) => m.reference.lifecycle)).toEqual([
      "Draft",
      "Archived",
    ]);
    expect(matches[1]?.references[0]?.version.recipeVersionReference).toBe(id(12));
    expect(matches[1]?.references[0]?.isCurrentRecipeVersion).toBe(false);
    expect(matches[1]?.target.versionReference).toBe(id(500));
    expect(matches[0]?.unresolved.flatMap((g) => g.modifiers.map((m) => m.reason))).toContain(
      "OptionNotEnabledInConfiguration",
    );
    expect(
      matches.every(
        (m) => m.applicability === "Unavailable" && m.recipeResolution === "Unavailable",
      ),
    ).toBe(true);
  });
  it("distinguishes absent selected SKU from unresolved stored binding and legal empty Recipe data", () => {
    const absent = matchRecipeProductPublicationReferenceGraphsV2({
      ...input(),
      targets: [{ ...target(7, 81), skuReference: id(6) }],
    });
    expect(absent[0]?.targetMembership).toBe("Absent");
    expect(absent[0]?.references).toEqual([]);
    const raw = {
      generation: null,
      bindingCount: null,
      observedAt: at,
      counts: { recipes: "0", versions: "0", bindings: "0", modifiers: "0" },
      recipes: [],
      versions: [],
      bindings: [],
      modifiers: [],
    };
    const empty = matchRecipeProductPublicationReferenceGraphsV2({
      ...input(),
      source: buildRecipeProductPublicationReferenceSnapshotV2(raw, request, at),
    });
    expect(empty[0]?.targetMembership).toBe("Present");
    expect(empty[0]?.recipeGeneration).toBe("0");
    expect(empty[0]?.references).toEqual([]);
    expect(empty[0]?.unresolved).toEqual([]);
  });
  it("uses separate V2 targets and full Product bindings without changing V1 matcher bytes", () => {
    expect(() =>
      matchRecipeProductPublicationReferenceGraphsV2({
        ...input(),
        targets: [recipeMatchTarget()],
      }),
    ).toThrow(denied);
    expect(() =>
      matchRecipeProductPublicationReferenceGraphsV2({
        ...input(),
        targets: [{ ...target(), productReference: id(999) }],
      }),
    ).toThrow(denied);
    expect(() =>
      matchRecipeCatalogReferenceGraphs({
        request: recipeMatchRequest,
        source: recipeMatchSource(),
        targets: [target()],
        now: at,
      }),
    ).toThrow(denied);
    const v1 = matchRecipeCatalogReferenceGraphs({
      request: recipeMatchRequest,
      source: recipeMatchSource(),
      targets: [recipeMatchTarget()],
      now: at,
    });
    expect(v1[0]?.coverage).toBe("KnownDraftBindingGraph");
    expect(v1[0]?.request).toEqual(recipeMatchRequest);
    expect(v1[0]?.references).toEqual(
      matchRecipeProductPublicationReferenceGraphsV2(input())[0]?.references,
    );
  });
  it("rejects sparse/accessor targets, incomplete graph scope and expanded budget", () => {
    const getter = vi.fn(() => target());
    const targets = [target()];
    Object.defineProperty(targets, "0", { enumerable: true, get: getter });
    expect(() => matchRecipeProductPublicationReferenceGraphsV2({ ...input(), targets })).toThrow(
      denied,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      matchRecipeProductPublicationReferenceGraphsV2({ ...input(), targets: new Array(1) }),
    ).toThrow(denied);
    expect(() =>
      matchRecipeProductPublicationReferenceGraphsV2({ ...input(), targets: [] }),
    ).toThrow(denied);
    expect(() =>
      matchRecipeProductPublicationReferenceGraphsV2({
        ...input(),
        targets: Array.from({ length: 1001 }, () => target()),
      }),
    ).toThrow(denied);
    const binding = target().bindings[0];
    if (!binding) throw new Error("fixture");
    expect(() =>
      matchRecipeProductPublicationReferenceGraphsV2({
        ...input(),
        targets: [{ ...target(), bindings: [{ ...binding, includedSkuReferences: [id(999)] }] }],
      }),
    ).toThrow(denied);
  });
  it("retains recursive pinned Inventory operation identities and every conditional historical change", () => {
    const result = matchRecipeInventoryProductPublicationReferenceRootsV2(rootsInput())[0];
    if (!result) throw new Error("fixture");
    expect(result.request).toEqual(inventoryRequest);
    expect(
      result.reachableVersions.some(
        (v) => v.version.recipeVersionReference === id(12) && !v.isCurrentRecipeVersion,
      ),
    ).toBe(true);
    const pinned = result.requirements.find(
      (r) => r.kind === "BaseIngredient" && r.reference.sourceKind === "InventoryItem",
    );
    if (!pinned || pinned.kind !== "BaseIngredient") throw new Error("fixture");
    expect(pinned.reference.sourceVersionReference).toBe("01902419-0000-7000-8000-000000000007");
    expect(result.requirements.some((r) => r.kind === "ModifierRemove" && r.conditional)).toBe(
      true,
    );
    expect(
      result.requirements.some(
        (r) => r.kind === "ModifierReplace" && r.modifier.lifecycle === "Archived",
      ),
    ).toBe(true);
    expect(result.removalResolution).toBe("Unavailable");
    expect(result.conditionalApplicability).toBe("Unavailable");
    expect(result.conditionalCycleResolution).toBe("Unavailable");
    expect(result.applicability).toBe("Unavailable");
    const empty = matchRecipeInventoryProductPublicationReferenceRootsV2({
      ...rootsInput(),
      rootGroups: [[]],
    });
    expect(empty[0]?.reachableVersions).toEqual([]);
    expect(empty[0]?.requirements).toEqual([]);
  });
  it("preserves legacy reachability and rejects invented roots, graph truncation or foreign envelope", () => {
    const oldRequest = {
      ...recipeMatchRequest,
      purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ" as const,
    };
    const legacy = matchRecipeInventoryReferenceRoots({
      request: oldRequest,
      source: recipeInventoryMatchSource(oldRequest),
      rootGroups: [[id(11)]],
      now: at,
    });
    expect(legacy[0]?.requirements).toEqual(
      matchRecipeInventoryProductPublicationReferenceRootsV2(rootsInput())[0]?.requirements,
    );
    expect(() =>
      matchRecipeInventoryReferenceRoots({
        request: oldRequest,
        source: recursive(),
        rootGroups: [[id(11)]],
        now: at,
      }),
    ).toThrow(denied);
    expect(() =>
      matchRecipeInventoryProductPublicationReferenceRootsV2({
        ...rootsInput(),
        rootGroups: [[id(999)]],
      }),
    ).toThrow(denied);
    expect(() =>
      matchRecipeInventoryProductPublicationReferenceRootsV2({
        ...rootsInput(),
        rootGroups: Array.from({ length: 1001 }, () => [id(11)]),
      }),
    ).toThrow(denied);
    expect(() =>
      matchRecipeInventoryProductPublicationReferenceRootsV2({
        ...rootsInput(),
        source: { ...recursive(), ingredients: [] },
      }),
    ).toThrow(denied);
    expect(() =>
      matchRecipeInventoryProductPublicationReferenceRootsV2({ ...rootsInput(), now: plus(5000) }),
    ).toThrow(denied);
  });
});
