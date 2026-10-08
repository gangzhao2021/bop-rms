import { createRecipeSnapshot, type RecipeSnapshot } from "../../domain/recipe.js";
import type { RecipeTransaction } from "./recipe-query-store.js";

/** Called only inside the owning repository transaction after authorization and version locking. */
export async function insertRecipeVersion(
  tx: RecipeTransaction,
  input: RecipeSnapshot,
  generateEvidenceReference: () => string,
): Promise<void> {
  const s = createRecipeSnapshot(input);
  await tx.query(
    "INSERT INTO rms_recipe.recipe_version (recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,display_name_code,yield_quantity_microunits,yield_unit_code,yield_dimension,preparation_version_id,substitution_policy_id,effective_from,effective_until,effective_time_zone,invalidation_reason_code,created_at,snapshot_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
    [
      s.versionReference,
      s.recipeReference,
      s.brandReference,
      s.versionNumber,
      s.snapshotDigest,
      s.lifecycle,
      s.displayNameCode,
      s.yieldQuantityMicrounits,
      s.yieldUnitCode,
      s.yieldDimension,
      s.preparationVersionReference,
      s.substitutionPolicyReference,
      s.effectivePeriod.effectiveFrom.instant,
      s.effectivePeriod.effectiveUntil?.instant ?? null,
      s.effectivePeriod.timeZone,
      s.invalidationReasonCode,
      s.createdAt,
      JSON.stringify(s),
    ],
  );
  for (const ingredient of s.ingredients) {
    await tx.query(
      "INSERT INTO rms_recipe.recipe_ingredient_requirement (requirement_id,recipe_version_id,recipe_id,brand_id,source_kind,source_id,source_version_id,quantity_microunits,unit_dimension,conversion_numerator,conversion_denominator,loss_basis_points,unit_cost_minor_numerator,unit_cost_denominator,allergen_declaration_evidence_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
      [
        ingredient.requirementReference,
        s.versionReference,
        s.recipeReference,
        s.brandReference,
        ingredient.sourceKind,
        ingredient.sourceReference,
        ingredient.sourceVersionReference,
        ingredient.quantityMicrounits,
        ingredient.unitDimension,
        ingredient.conversionNumerator,
        ingredient.conversionDenominator,
        ingredient.lossBasisPoints,
        ingredient.unitCostMinorNumerator,
        ingredient.unitCostDenominator,
        ingredient.allergenDeclarationReference ?? null,
      ],
    );
    for (const evidence of ingredient.allergens) {
      await tx.query(
        "INSERT INTO rms_recipe.recipe_allergen_evidence (recipe_allergen_evidence_id,requirement_id,brand_id,allergen_id,evidence_id,verified,recipe_version_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          generateEvidenceReference(),
          ingredient.requirementReference,
          s.brandReference,
          evidence.allergenReference,
          evidence.evidenceReference,
          evidence.verified,
          s.versionReference,
        ],
      );
    }
  }
  for (const step of s.steps) {
    await tx.query(
      "INSERT INTO rms_recipe.recipe_preparation_step (step_id,recipe_version_id,recipe_id,brand_id,sequence_group,instruction_code,duration_seconds,capability_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        step.stepReference,
        s.versionReference,
        s.recipeReference,
        s.brandReference,
        step.sequenceGroup,
        step.instructionCode,
        step.durationSeconds,
        step.capabilityCode,
      ],
    );
  }
}
