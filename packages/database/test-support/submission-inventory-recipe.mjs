import { publishSubmissionRecipe } from "./submission-recipe-publication.mjs";
/** Synthetic published Recipe/selection fixture; production authoring and review are separate. */
export async function seedSubmissionInventoryRecipe({
  admin,
  scope,
  actorReference,
  at,
  cart,
  stock,
}) {
  const id = (n) =>
    n === 2
      ? scope.brandReference
      : n === 3
        ? actorReference
        : "01909994-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const digest = (c) => "sha256:" + c.repeat(64);
  const snapshot = {
    recipeReference: id(1),
    versionReference: id(4),
    brandReference: id(2),
    stableCode: "SYNTHETIC_RECIPE",
    aggregateVersion: 2,
    versionNumber: 2,
    snapshotDigest: digest("a"),
    lifecycle: "Published",
    displayNameCode: "SYNTHETIC_NAME",
    yieldQuantityMicrounits: "1000000",
    yieldUnitCode: "EACH",
    yieldDimension: "Count",
    ingredients: [
      {
        requirementReference: id(6),
        sourceKind: "InventoryItem",
        sourceReference: stock.itemReference,
        sourceVersionReference: stock.configurationOperationReference,
        quantityMicrounits: "1000000",
        unitDimension: "Mass",
        conversionNumerator: "1",
        conversionDenominator: "1",
        lossBasisPoints: 0,
        unitCostMinorNumerator: "3",
        unitCostDenominator: "1000000",
        allergens: [],
      },
    ],
    preparationVersionReference: id(5),
    steps: [
      {
        stepReference: id(22),
        sequenceGroup: 0,
        instructionCode: "PREPARE",
        durationSeconds: 60,
        capabilityCode: "PREP",
      },
    ],
    substitutionPolicyReference: null,
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: {
        instant: at,
        localDateTime: at.slice(0, -1),
        utcOffsetMinutes: 0,
      },
      effectiveUntil: null,
    },
    invalidationReasonCode: null,
    createdAt: at,
  };
  await publishSubmissionRecipe(admin, snapshot, actorReference, id);

  for (const [index, line] of cart.items.entries()) {
    await admin.query(
      "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES($1,$2,$3,$4,$5,NULL,$6)",
      [id(200 + index), id(4), id(1), scope.brandReference, line.sellableReference, at],
    );
    for (const [optionIndex, selection] of line.optionSelections.entries()) {
      const n = 1000 + index * 100 + optionIndex * 10;
      const rule = {
        ruleReference: id(n),
        ruleVersionReference: id(n + 1),
        ruleDigest: digest("a"),
        brandReference: scope.brandReference,
        recipeVersionReference: id(4),
        selection: {
          bindingReference:
            line.catalogSelectionEvidence.ruleEvidence[optionIndex].bindingReference,
          optionReference: selection.optionReference,
          quantity: selection.quantity,
        },
        changes: [],
      };
      const proof = {
        ruleReference: rule.ruleReference,
        ruleVersionReference: rule.ruleVersionReference,
        brandReference: scope.brandReference,
        recipeVersionReference: id(4),
        ruleDigest: rule.ruleDigest,
        draftAuthorActorReference: actorReference,
        reviews: ["Cost", "FoodSafety"].map((reviewKind, i) => ({
          reviewReference: id(n + 5 + i),
          reviewKind,
          reviewerActorReference: id(9000 + i),
          evidenceDigest: digest("b"),
          decision: "Approved",
          reviewedAt: at,
        })),
      };
      await admin.query(
        "INSERT INTO rms_recipe.recipe_modifier_version(rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,operation_id,actor_id,audit_id,occurred_at,review_evidence_json) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,'Published',$9,$10,$11,$12,$13,$14,$11,$15)",
        [
          rule.ruleVersionReference,
          rule.ruleReference,
          scope.brandReference,
          id(1),
          id(4),
          rule.selection.bindingReference,
          selection.optionReference,
          selection.quantity,
          rule.ruleDigest,
          rule,
          at,
          id(n + 2),
          actorReference,
          id(n + 3),
          proof,
        ],
      );
    }
  }
}
