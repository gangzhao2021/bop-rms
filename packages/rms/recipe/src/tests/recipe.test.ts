import { createEffectivePeriod } from "@bop/effective-period";
import { describe, expect, it } from "vitest";
import {
  calculateRecipe,
  createRecipeSnapshot,
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeReference,
  validateRecipeGraph,
  type RecipeSnapshot,
} from "../index.js";

const id = (n: number) =>
  parseRecipeReference(`018f9800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = "2026-08-13T18:00:00.000Z";
const period = createEffectivePeriod({
  timeZone: "America/Toronto",
  effectiveFrom: {
    instant: "2026-08-01T04:00:00.000Z" as never,
    localDateTime: "2026-08-01T00:00:00.000",
    utcOffsetMinutes: -240,
  },
  effectiveUntil: null,
});
function recipe(
  options: { version?: number; lifecycle?: RecipeSnapshot["lifecycle"]; sub?: RecipeSnapshot } = {},
): RecipeSnapshot {
  const version = options.version ?? 1;
  return {
    recipeReference: id(1),
    versionReference: id(version + 1),
    brandReference: id(10),
    stableCode: parseRecipeCode("SYNTHETIC_RECIPE"),
    aggregateVersion: version,
    versionNumber: version,
    snapshotDigest: parseRecipeDigest(`sha256:${version.toString(16).repeat(64)}`),
    lifecycle: options.lifecycle ?? "Draft",
    displayNameCode: parseRecipeCode("SYNTHETIC_NAME"),
    yieldQuantityMicrounits: "1000000",
    yieldUnitCode: parseRecipeCode("PORTION"),
    yieldDimension: "Count",
    ingredients: [
      {
        requirementReference: id(20),
        sourceKind: options.sub ? "SubRecipe" : "InventoryItem",
        sourceReference: options.sub?.recipeReference ?? id(21),
        sourceVersionReference: options.sub?.versionReference ?? id(22),
        quantityMicrounits: "1000000",
        unitDimension: "Mass",
        conversionNumerator: "2",
        conversionDenominator: "1",
        lossBasisPoints: 1000,
        unitCostMinorNumerator: "3",
        unitCostDenominator: "1000000",
        allergens: [{ allergenReference: id(30), evidenceReference: id(31), verified: true }],
      },
    ],
    preparationVersionReference: id(40),
    steps: [
      {
        stepReference: id(41),
        sequenceGroup: 0,
        instructionCode: parseRecipeCode("MIX"),
        durationSeconds: 60,
        capabilityCode: parseRecipeCode("PREP"),
      },
    ],
    substitutionPolicyReference: null,
    effectivePeriod: period,
    invalidationReasonCode:
      options.lifecycle === "Invalidated" ? parseRecipeCode("SAFETY_REVIEW") : null,
    createdAt: at,
  };
}
describe("Recipe domain", () => {
  it("calculates exact converted quantity, loss, cost and allergen union", () => {
    expect(calculateRecipe(recipe())).toMatchObject({
      totalCostMinor: "7",
      allergenReferences: [id(30)],
      requirements: [{ baseQuantityMicrounits: "2200000", costMinor: "7" }],
    });
  });
  it("pins and validates a bounded Sub-recipe graph", () => {
    const child = { ...recipe({ version: 2 }), recipeReference: id(50), versionReference: id(51) };
    expect(validateRecipeGraph(recipe({ sub: child }), [child])).toBe(true);
  });
  it("rejects direct cycles and unverified published allergen evidence", () => {
    const cyclic = recipe();
    const cyclicIngredient = cyclic.ingredients.at(0);
    if (cyclicIngredient === undefined) throw new Error("fixture ingredient missing");
    const parent = {
      ...cyclic,
      ingredients: [
        {
          ...cyclicIngredient,
          sourceKind: "SubRecipe" as const,
          sourceReference: cyclic.recipeReference,
          sourceVersionReference: cyclic.versionReference,
        },
      ],
    };
    expect(() => validateRecipeGraph(parent, [])).toThrowError(
      expect.objectContaining({ code: "RECIPE_GRAPH_CYCLE" }),
    );
    const draft = recipe({ lifecycle: "Published" });
    const draftIngredient = draft.ingredients.at(0);
    const draftAllergen = draftIngredient?.allergens.at(0);
    if (draftIngredient === undefined || draftAllergen === undefined)
      throw new Error("fixture evidence missing");
    expect(() =>
      createRecipeSnapshot({
        ...draft,
        ingredients: [
          {
            ...draftIngredient,
            allergens: [{ ...draftAllergen, verified: false }],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "RECIPE_ALLERGEN_UNVERIFIED" }));
  });
});
