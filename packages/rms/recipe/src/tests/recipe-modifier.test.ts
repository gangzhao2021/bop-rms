import { createEffectivePeriod } from "@bop/effective-period";
import { describe, expect, it } from "vitest";
import {
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeReference,
  applyRecipeIngredientModifiers,
  parseRecipeModifierRule,
  calculateConfiguredRecipeInventoryDemand,
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
describe("Recipe ingredient modifiers", () => {
  const base = recipe({ lifecycle: "Published" });
  const selection = { bindingReference: id(60), optionReference: id(61), quantity: 2 };
  const rule = {
    ruleReference: id(62),
    ruleVersionReference: id(63),
    ruleDigest: "sha256:" + "a".repeat(64),
    brandReference: base.brandReference,
    recipeVersionReference: base.versionReference,
    selection,
    changes: [],
  };
  it("requires an explicit matching rule even for no ingredient impact", () => {
    expect(applyRecipeIngredientModifiers(base, [selection], [rule]).ingredients).toEqual(
      base.ingredients,
    );
    expect(() => applyRecipeIngredientModifiers(base, [selection], [])).toThrow();
    expect(() =>
      applyRecipeIngredientModifiers(
        base,
        [selection],
        [{ ...rule, selection: { ...selection, quantity: 1 } }],
      ),
    ).toThrow();
  });
  it("applies explicit replacement quantities and retains base version unchanged", () => {
    const ingredient = base.ingredients[0];
    if (!ingredient) throw new Error("fixture");
    const result = applyRecipeIngredientModifiers(
      base,
      [selection],
      [
        {
          ...rule,
          changes: [
            {
              action: "Replace",
              requirementReference: ingredient.requirementReference,
              ingredient: { ...ingredient, quantityMicrounits: "2500000" },
            },
          ],
        },
      ],
    );
    expect(result.ingredients[0]?.quantityMicrounits).toBe("2500000");
    expect(result.baseSnapshot.ingredients[0]?.quantityMicrounits).toBe("1000000");
    expect(result.appliedRules[0]?.ruleVersionReference).toBe(id(63));
  });
  it("calculates selected-option demand and retains independent rule provenance", () => {
    const ingredient = base.ingredients[0];
    if (!ingredient) throw new Error("fixture");
    const configuredRule = {
      ...rule,
      changes: [
        {
          action: "Replace" as const,
          requirementReference: ingredient.requirementReference,
          ingredient: { ...ingredient, quantityMicrounits: "2500000" },
        },
      ],
    };
    const result = calculateConfiguredRecipeInventoryDemand(
      base,
      [],
      [selection],
      [configuredRule],
      "1000000",
    );
    expect(result.requirements[0]).toMatchObject({
      quantityNumerator: "5500000",
      quantityDenominator: "1",
    });
    expect(result.appliedRules[0]?.ruleVersionReference).toBe(id(63));
    expect(result.baseSnapshot).toEqual(base);
    expect(() =>
      calculateConfiguredRecipeInventoryDemand(base, [], [selection], [], "1000000"),
    ).toThrow();
  });
  it("rejects untrusted rule fields without invoking top-level accessors", () => {
    let accessed = false;
    const withGetter = { ...rule };
    Object.defineProperty(withGetter, "ruleDigest", {
      enumerable: true,
      get() {
        accessed = true;
        return rule.ruleDigest;
      },
    });
    expect(() => parseRecipeModifierRule(withGetter, base)).toThrow();
    expect(accessed).toBe(false);
    expect(() => parseRecipeModifierRule({ ...rule, unexpected: true }, base)).toThrow();
    expect(() => parseRecipeModifierRule({ ...rule, changes: new Array(1) }, base)).toThrow();
    expect(() =>
      parseRecipeModifierRule({ ...rule, selection: { ...selection, quantity: 0 } }, base),
    ).toThrow();
  });
  it("rejects conflicting edits and cross-brand rules", () => {
    const ingredient = base.ingredients[0];
    if (!ingredient) throw new Error("fixture");
    expect(() =>
      applyRecipeIngredientModifiers(base, [selection], [{ ...rule, brandReference: id(99) }]),
    ).toThrow();
    expect(() =>
      applyRecipeIngredientModifiers(
        base,
        [selection],
        [
          {
            ...rule,
            changes: [
              { action: "Remove", requirementReference: ingredient.requirementReference },
              { action: "Remove", requirementReference: ingredient.requirementReference },
            ],
          },
        ],
      ),
    ).toThrow();
  });
});
