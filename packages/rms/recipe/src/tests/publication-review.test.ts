import { createEffectivePeriod } from "@bop/effective-period";
import { describe, expect, it } from "vitest";
import {
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeReference,
  parseRecipePublicationEvidence,
  parseRecipeModifierPublicationEvidence,
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
describe("Recipe publication evidence", () => {
  const target = recipe({ lifecycle: "Published" });
  const evidence = {
    recipeReference: target.recipeReference,
    versionReference: target.versionReference,
    brandReference: target.brandReference,
    snapshotDigest: target.snapshotDigest,
    draftAuthorActorReference: id(60),
    reviews: [
      {
        reviewReference: id(61),
        reviewKind: "Cost",
        reviewerActorReference: id(62),
        evidenceDigest: "sha256:" + "a".repeat(64),
        reviewedAt: at,
        decision: "Approved",
      },
      {
        reviewReference: id(63),
        reviewKind: "FoodSafety",
        reviewerActorReference: id(64),
        evidenceDigest: "sha256:" + "b".repeat(64),
        reviewedAt: at,
        decision: "Approved",
      },
    ],
  };
  it("retains distinct approved reviews bound to the exact version", () => {
    const result = parseRecipePublicationEvidence(evidence, target);
    expect(result).toEqual(evidence);
    expect(Object.isFrozen(result.reviews)).toBe(true);
  });
  it("binds modifier review to the rule version and digest independently of its base", () => {
    const rule = {
      ruleReference: id(80),
      ruleVersionReference: id(81),
      ruleDigest: "sha256:" + "d".repeat(64),
      brandReference: target.brandReference,
      recipeVersionReference: target.versionReference,
      selection: { bindingReference: id(82), optionReference: id(83), quantity: 1 },
      changes: [],
    };
    const proof = {
      ruleReference: rule.ruleReference,
      ruleVersionReference: rule.ruleVersionReference,
      brandReference: rule.brandReference,
      recipeVersionReference: rule.recipeVersionReference,
      ruleDigest: rule.ruleDigest,
      draftAuthorActorReference: evidence.draftAuthorActorReference,
      reviews: evidence.reviews,
    };
    expect(parseRecipeModifierPublicationEvidence(proof, rule, at)).toEqual(proof);
    expect(() =>
      parseRecipeModifierPublicationEvidence(
        { ...proof, ruleDigest: target.snapshotDigest },
        rule,
        at,
      ),
    ).toThrow();
    expect(() =>
      parseRecipeModifierPublicationEvidence(
        { ...proof, ruleVersionReference: target.versionReference },
        rule,
        at,
      ),
    ).toThrow();
  });
  it("rejects mismatched scope, missing reviews, duplicate reviewers and future decisions", () => {
    for (const candidate of [
      { ...evidence, brandReference: id(99) },
      { ...evidence, versionReference: id(99) },
      { ...evidence, snapshotDigest: "sha256:" + "c".repeat(64) },
      { ...evidence, reviews: [] },
      {
        ...evidence,
        reviews: [evidence.reviews[0], { ...evidence.reviews[1], reviewerActorReference: id(62) }],
      },
      {
        ...evidence,
        reviews: [{ ...evidence.reviews[0], reviewerActorReference: id(60) }, evidence.reviews[1]],
      },
      {
        ...evidence,
        reviews: [
          { ...evidence.reviews[0], reviewedAt: "2027-01-01T00:00:00.000Z" },
          evidence.reviews[1],
        ],
      },
    ])
      expect(() => parseRecipePublicationEvidence(candidate, target)).toThrowError(
        expect.objectContaining({ code: "RECIPE_INPUT_INVALID" }),
      );
  });
});
