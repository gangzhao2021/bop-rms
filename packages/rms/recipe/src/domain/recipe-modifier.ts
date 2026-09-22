import { calculateRecipeInventoryDemand } from "./recipe-demand.js";
import {
  createRecipeSnapshot,
  parseRecipeReference,
  parseRecipeDigest,
  RecipeError,
  type RecipeSnapshot,
  type IngredientRequirement,
} from "./recipe.js";
export interface RecipeOptionSelection {
  readonly bindingReference: string;
  readonly optionReference: string;
  readonly quantity: number;
}
export type RecipeIngredientChange =
  | { readonly action: "Add"; readonly ingredient: IngredientRequirement }
  | { readonly action: "Remove"; readonly requirementReference: string }
  | {
      readonly action: "Replace";
      readonly requirementReference: string;
      readonly ingredient: IngredientRequirement;
    };
export interface RecipeModifierRule {
  readonly ruleReference: string;
  readonly ruleVersionReference: string;
  readonly ruleDigest: string;
  readonly brandReference: string;
  readonly recipeVersionReference: string;
  readonly selection: RecipeOptionSelection;
  readonly changes: readonly RecipeIngredientChange[];
}
function fail(): never {
  throw new RecipeError("RECIPE_INPUT_INVALID");
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[field] = descriptor.value;
  }
  return result;
}
function dense(value: unknown, limit: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    result.push(d.value);
  }
  return result;
}
export function parseRecipeOptionSelection(value: unknown): RecipeOptionSelection {
  const raw = closed(value, ["bindingReference", "optionReference", "quantity"]);
  if (
    !Number.isSafeInteger(raw.quantity) ||
    (raw.quantity as number) < 1 ||
    (raw.quantity as number) > 10000
  )
    return fail();
  return Object.freeze({
    bindingReference: parseRecipeReference(raw.bindingReference),
    optionReference: parseRecipeReference(raw.optionReference),
    quantity: raw.quantity as number,
  });
}
export function parseRecipeModifierRule(
  value: unknown,
  baseInput: RecipeSnapshot,
): RecipeModifierRule {
  const base = createRecipeSnapshot(baseInput);
  const raw = closed(value, [
    "ruleReference",
    "ruleVersionReference",
    "ruleDigest",
    "brandReference",
    "recipeVersionReference",
    "selection",
    "changes",
  ]);
  if (
    raw.brandReference !== base.brandReference ||
    raw.recipeVersionReference !== base.versionReference
  )
    return fail();
  const changes = dense(raw.changes, 256).map((value): RecipeIngredientChange => {
    if (value === null || typeof value !== "object") return fail();
    const action = Object.getOwnPropertyDescriptor(value, "action");
    if (!action || !("value" in action)) return fail();
    if (action.value === "Remove") {
      const change = closed(value, ["action", "requirementReference"]);
      return Object.freeze({
        action: "Remove",
        requirementReference: parseRecipeReference(change.requirementReference),
      });
    }
    if (action.value !== "Add" && action.value !== "Replace") return fail();
    const change = closed(
      value,
      action.value === "Add"
        ? ["action", "ingredient"]
        : ["action", "requirementReference", "ingredient"],
    );
    const ingredient = createRecipeSnapshot({
      ...base,
      ingredients: [change.ingredient as IngredientRequirement],
    }).ingredients[0];
    if (!ingredient) return fail();
    return action.value === "Add"
      ? Object.freeze({ action: "Add", ingredient })
      : Object.freeze({
          action: "Replace",
          requirementReference: parseRecipeReference(change.requirementReference),
          ingredient,
        });
  });
  return Object.freeze({
    ruleReference: parseRecipeReference(raw.ruleReference),
    ruleVersionReference: parseRecipeReference(raw.ruleVersionReference),
    ruleDigest: parseRecipeDigest(raw.ruleDigest),
    brandReference: base.brandReference,
    recipeVersionReference: base.versionReference,
    selection: parseRecipeOptionSelection(raw.selection),
    changes: Object.freeze(changes),
  });
}
function key(s: RecipeOptionSelection): string {
  const binding = parseRecipeReference(s.bindingReference),
    option = parseRecipeReference(s.optionReference);
  if (!Number.isSafeInteger(s.quantity) || s.quantity < 1 || s.quantity > 10000) return fail();
  return binding + ":" + option + ":" + s.quantity;
}
/** Pure composition. Rules contain explicit final amounts for the exact selected quantity. */
export function applyRecipeIngredientModifiers(
  baseInput: RecipeSnapshot,
  selections: readonly RecipeOptionSelection[],
  rules: readonly RecipeModifierRule[],
) {
  const base = createRecipeSnapshot(baseInput);
  selections = dense(selections, 256).map(parseRecipeOptionSelection);
  rules = dense(rules, 256).map((rule) => parseRecipeModifierRule(rule, base));
  if (
    !Array.isArray(selections) ||
    !Array.isArray(rules) ||
    selections.length > 256 ||
    rules.length !== selections.length
  )
    return fail();
  const selected = selections.map(key);
  if (new Set(selected).size !== selected.length) return fail();
  const indexed = new Map<string, RecipeModifierRule>();
  const ids = new Set<string>();
  for (const rule of rules) {
    const k = key(rule.selection),
      id = parseRecipeReference(rule.ruleReference);
    parseRecipeReference(rule.ruleVersionReference);
    parseRecipeDigest(rule.ruleDigest);
    if (
      rule.brandReference !== base.brandReference ||
      rule.recipeVersionReference !== base.versionReference ||
      !selected.includes(k) ||
      indexed.has(k) ||
      ids.has(id) ||
      !Array.isArray(rule.changes) ||
      rule.changes.length > 256
    )
      return fail();
    indexed.set(k, rule);
    ids.add(id);
  }
  const ingredients = new Map(base.ingredients.map((i) => [String(i.requirementReference), i]));
  const touched = new Set<string>();
  for (const k of selected) {
    const rule = indexed.get(k);
    if (!rule) return fail();
    for (const change of rule.changes) {
      const target =
        change.action === "Add"
          ? parseRecipeReference(change.ingredient.requirementReference)
          : parseRecipeReference(change.requirementReference);
      if (touched.has(target)) return fail();
      touched.add(target);
      if (change.action === "Add") {
        if (ingredients.has(target)) return fail();
        ingredients.set(target, change.ingredient);
      } else if (change.action === "Remove") {
        if (!ingredients.delete(target)) return fail();
      } else if (change.action === "Replace") {
        if (!ingredients.has(target) || change.ingredient.requirementReference !== target)
          return fail();
        ingredients.set(target, change.ingredient);
      } else return fail();
    }
  }
  // Validate configured ingredients without presenting them as a new published base snapshot.
  const parsed = createRecipeSnapshot({ ...base, ingredients: [...ingredients.values()] });
  return Object.freeze({
    baseSnapshot: base,
    ingredients: parsed.ingredients,
    appliedRules: Object.freeze(
      selected.map((k) => {
        const rule = indexed.get(k);
        if (!rule) return fail();
        return Object.freeze({
          ruleReference: rule.ruleReference,
          ruleVersionReference: rule.ruleVersionReference,
          ruleDigest: rule.ruleDigest,
          selection: Object.freeze({ ...rule.selection }),
        });
      }),
    ),
  });
}

/** Configured theoretical demand keeps the published base and applied rule evidence separate. */
export function calculateConfiguredRecipeInventoryDemand(
  baseInput: RecipeSnapshot,
  availableInputs: readonly RecipeSnapshot[],
  selections: readonly RecipeOptionSelection[],
  rules: readonly RecipeModifierRule[],
  requestedYieldMicrounits: string,
) {
  const configured = applyRecipeIngredientModifiers(baseInput, selections, rules);
  const calculationInput = createRecipeSnapshot({
    ...configured.baseSnapshot,
    ingredients: configured.ingredients,
  });
  const requirements = calculateRecipeInventoryDemand(
    calculationInput,
    availableInputs,
    requestedYieldMicrounits,
  );
  return Object.freeze({
    baseSnapshot: configured.baseSnapshot,
    appliedRules: configured.appliedRules,
    requestedYieldMicrounits,
    requirements,
  });
}
