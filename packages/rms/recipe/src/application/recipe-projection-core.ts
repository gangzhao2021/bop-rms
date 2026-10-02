import type { IngredientRequirement, RecipeSnapshot } from "../domain/recipe.js";
import { parseRecipeProjectionFacts } from "./recipe-projection-facts.js";
import {
  buildRecipeProjectionGraph,
  type RecipeProjectionGraph,
} from "./recipe-projection-graph.js";
import { RecipeProjectionGraphError } from "./recipe-projection-graph-error.js";
export type RecipeProjectionCoreIngredient = Pick<
  IngredientRequirement,
  | "requirementReference"
  | "sourceKind"
  | "sourceReference"
  | "sourceVersionReference"
  | "quantityMicrounits"
  | "unitDimension"
  | "conversionNumerator"
  | "conversionDenominator"
  | "lossBasisPoints"
>;
export type RecipeProjectionCoreRow = Pick<
  RecipeSnapshot,
  | "recipeReference"
  | "versionReference"
  | "stableCode"
  | "aggregateVersion"
  | "versionNumber"
  | "snapshotDigest"
  | "lifecycle"
  | "displayNameCode"
  | "yieldQuantityMicrounits"
  | "yieldUnitCode"
  | "yieldDimension"
  | "preparationVersionReference"
  | "steps"
  | "substitutionPolicyReference"
  | "effectivePeriod"
  | "invalidationReasonCode"
  | "createdAt"
> & {
  readonly ingredients: readonly RecipeProjectionCoreIngredient[];
};
export interface RecipeProjectionCore {
  readonly graph: RecipeProjectionGraph;
  readonly rows: readonly RecipeProjectionCoreRow[];
}
/** Internal source-backed configuration only. Caller must hold actual field authority and current
 * owner facts. No name/currency/safety/Inventory mapping or executable preparation is inferred. */
export function buildRecipeProjectionCore(value: unknown): RecipeProjectionCore {
  try {
    // Snapshot once before any graph/core derivation; untrusted caller mutation cannot split them.
    const facts = parseRecipeProjectionFacts(value),
      graph = buildRecipeProjectionGraph(facts),
      byVersion = new Map(facts.recipes.map((item) => [item.versionReference, item]));
    for (const recipe of facts.recipes) {
      for (const item of recipe.ingredients) {
        if (item.sourceKind !== "SubRecipe") continue;
        const child = byVersion.get(item.sourceVersionReference);
        if (!child || child.yieldDimension !== item.unitDimension)
          throw new RecipeProjectionGraphError("RECIPE_PROJECTION_GRAPH_UNRESOLVED");
      }
    }
    const rows = [...facts.currentRecipes]
      .sort((a, b) => a.recipeReference.localeCompare(b.recipeReference))
      .map((item): RecipeProjectionCoreRow =>
        Object.freeze({
          recipeReference: item.recipeReference,
          versionReference: item.versionReference,
          stableCode: item.stableCode,
          aggregateVersion: item.aggregateVersion,
          versionNumber: item.versionNumber,
          snapshotDigest: item.snapshotDigest,
          lifecycle: item.lifecycle,
          displayNameCode: item.displayNameCode,
          yieldQuantityMicrounits: item.yieldQuantityMicrounits,
          yieldUnitCode: item.yieldUnitCode,
          yieldDimension: item.yieldDimension,
          ingredients: Object.freeze(
            item.ingredients.map((requirement) =>
              Object.freeze({
                requirementReference: requirement.requirementReference,
                sourceKind: requirement.sourceKind,
                sourceReference: requirement.sourceReference,
                sourceVersionReference: requirement.sourceVersionReference,
                quantityMicrounits: requirement.quantityMicrounits,
                unitDimension: requirement.unitDimension,
                conversionNumerator: requirement.conversionNumerator,
                conversionDenominator: requirement.conversionDenominator,
                lossBasisPoints: requirement.lossBasisPoints,
              }),
            ),
          ),
          preparationVersionReference: item.preparationVersionReference,
          steps: item.steps,
          substitutionPolicyReference: item.substitutionPolicyReference,
          effectivePeriod: item.effectivePeriod,
          invalidationReasonCode: item.invalidationReasonCode,
          createdAt: item.createdAt,
        }),
      );
    return Object.freeze({ graph, rows: Object.freeze(rows) });
  } catch (error) {
    if (error instanceof RecipeProjectionGraphError) throw error;
    throw new RecipeProjectionGraphError("RECIPE_PROJECTION_GRAPH_INPUT_INVALID");
  }
}
