import {
  createRecipeSnapshot,
  parseRecipeReference,
  type RecipeSnapshot,
} from "../../domain/recipe.js";
import {
  parseRecipeModifierRule,
  parseRecipeOptionSelection,
  type RecipeOptionSelection,
} from "../../domain/recipe-modifier.js";
import { parseRecipeModifierPublicationEvidence } from "../../domain/publication-review.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import type { RecipeTransactionRunner } from "./recipe-query-store.js";
function fail(): never {
  throw new RecipeWorkflowError("RECIPE_EVIDENCE_INCOMPLETE");
}
/** Current published rule evidence; authorization of configuration writes is separate. */
export function createPostgresRecipeModifierSource(runner: RecipeTransactionRunner) {
  async function resolve(
    baseInput: RecipeSnapshot,
    selectionsInput: readonly (
      RecipeOptionSelection | Readonly<{ optionReference: string; quantity: number }>
    )[],
    at: string,
    bindingRequired = true,
  ) {
    const base = createRecipeSnapshot(baseInput);
    if (
      !Array.isArray(selectionsInput) ||
      selectionsInput.length > 256 ||
      !Number.isFinite(Date.parse(at)) ||
      new Date(at).toISOString() !== at
    )
      return fail();
    const selections = selectionsInput.map((value) => {
      if (bindingRequired) return parseRecipeOptionSelection(value);
      if (
        value === null ||
        typeof value !== "object" ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Reflect.ownKeys(value).length !== 2
      )
        return fail();
      const option = Object.getOwnPropertyDescriptor(value, "optionReference");
      const quantity = Object.getOwnPropertyDescriptor(value, "quantity");
      if (
        !option?.enumerable ||
        !("value" in option) ||
        !quantity?.enumerable ||
        !("value" in quantity) ||
        !Number.isSafeInteger(quantity.value) ||
        quantity.value < 1 ||
        quantity.value > 10000
      )
        return fail();
      return {
        bindingReference: null,
        optionReference: parseRecipeReference(option.value),
        quantity: quantity.value as number,
      };
    });
    if (
      !bindingRequired &&
      new Set(selections.map((s) => s.optionReference)).size !== selections.length
    )
      return fail();
    try {
      return await runner.run(async (tx) => {
        await tx.query("SELECT set_config('bop.brand_id',$1,true)", [base.brandReference]);
        const rules = [];
        for (const selection of selections) {
          const result = await tx.query(
            "WITH current_versions AS (SELECT DISTINCT ON (rule_id) * FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1 AND occurred_at<=$5::timestamptz AND lifecycle<>'Draft' AND effective_from<=$5::timestamptz ORDER BY rule_id,version DESC) SELECT rule_json AS rule,review_evidence_json AS evidence,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS published_at FROM current_versions WHERE lifecycle='Published' AND recipe_version_id=$2 AND ($3::uuid IS NULL OR binding_id=$3) AND option_id=$4 AND selected_quantity=$6 AND effective_from<=$5::timestamptz AND (effective_until IS NULL OR effective_until>$5::timestamptz)",
            [
              base.brandReference,
              base.versionReference,
              selection.bindingReference,
              selection.optionReference,
              at,
              selection.quantity,
            ],
          );
          if (result === null || typeof result !== "object") return fail();
          const d = Object.getOwnPropertyDescriptor(result, "rows");
          if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length !== 1)
            return fail();
          const row = d.value[0];
          if (row === null || typeof row !== "object") return fail();
          const rule = parseRecipeModifierRule(row.rule, base);
          if (
            (selection.bindingReference !== null &&
              rule.selection.bindingReference !== selection.bindingReference) ||
            rule.selection.optionReference !== selection.optionReference ||
            rule.selection.quantity !== selection.quantity
          )
            return fail();
          parseRecipeModifierPublicationEvidence(row.evidence, rule, row.published_at);
          rules.push(rule);
        }
        return Object.freeze(rules);
      });
    } catch {
      return fail();
    }
  }
  return Object.freeze({
    resolve: (base: RecipeSnapshot, selections: readonly RecipeOptionSelection[], at: string) =>
      resolve(base, selections, at),
    resolveOptions: (
      base: RecipeSnapshot,
      options: readonly Readonly<{ optionReference: string; quantity: number }>[],
      at: string,
    ) => resolve(base, options, at, false),
  });
}
