import { createEffectivePeriod } from "@bop/effective-period";
import { describe, expect, it } from "vitest";
import {
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeReference,
  calculateRecipeInventoryDemand,
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
describe("Recipe inventory demand", () => {
  it("scales explicit yield without losing fractional microunits", () => {
    const root = { ...recipe({ lifecycle: "Published" }), yieldQuantityMicrounits: "3000000" };
    const demand = calculateRecipeInventoryDemand(root, [], "1000000");
    expect(demand[0]).toMatchObject({
      itemReference: id(21),
      itemVersionReference: id(22),
      quantityNumerator: "2200000",
      quantityDenominator: "3",
    });
    expect(Object.isFrozen(demand[0]?.sourcePath)).toBe(true);
  });
  it("expands pinned SubRecipe amounts against child yield and retains provenance", () => {
    const child = {
      ...recipe({ version: 2, lifecycle: "Published" }),
      recipeReference: id(50),
      versionReference: id(51),
      yieldDimension: "Mass" as const,
      yieldUnitCode: parseRecipeCode("KG"),
      yieldQuantityMicrounits: "2000000",
    };
    const root = recipe({ lifecycle: "Published", sub: child });
    const demand = calculateRecipeInventoryDemand(root, [child], "1000000");
    expect(demand[0]).toMatchObject({ quantityNumerator: "2420000", quantityDenominator: "1" });
    expect(demand[0]?.sourcePath.map((s) => s.versionReference)).toEqual([
      root.versionReference,
      child.versionReference,
    ]);
  });
  it("rejects unpublished, unresolved and dimension-incompatible demand", () => {
    expect(() => calculateRecipeInventoryDemand(recipe(), [], "1000000")).toThrow();
    const child = {
      ...recipe({ version: 2, lifecycle: "Published" }),
      recipeReference: id(50),
      versionReference: id(51),
    };
    const root = recipe({ lifecycle: "Published", sub: child });
    expect(() => calculateRecipeInventoryDemand(root, [], "1000000")).toThrow();
    expect(() => calculateRecipeInventoryDemand(root, [child], "1000000")).toThrow();
  });
});
