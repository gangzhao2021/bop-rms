import {
  buildRecipeInventoryReferenceSnapshot,
  type RecipeInventoryReferenceRequest,
} from "../index.js";
import {
  recipeMatchRaw,
  recipeMatchId as id,
  recipeMatchAt as at,
} from "./recipe-catalog-reference-matches.fixture.js";
export const recipeInventoryItemId = (n: number) =>
  `01902419-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
export function recipeInventoryMatchRaw() {
  const base = recipeMatchRaw(),
    item = recipeInventoryItemId;
  const ingredients = [
    {
      recipeReference: id(10),
      recipeVersionReference: id(11),
      brandReference: id(1),
      requirementReference: id(50),
      sourceKind: "SubRecipe",
      sourceReference: id(10),
      sourceVersionReference: id(12),
    },
    {
      recipeReference: id(10),
      recipeVersionReference: id(12),
      brandReference: id(1),
      requirementReference: id(51),
      sourceKind: "InventoryItem",
      sourceReference: item(6),
      sourceVersionReference: item(7),
    },
  ];
  const changes = [
    {
      ruleVersionReference: id(41),
      sequence: 1,
      action: "Add",
      requirementReference: id(60),
      sourceKind: "InventoryItem",
      sourceReference: item(20),
      sourceVersionReference: item(27),
    },
    { ruleVersionReference: id(41), sequence: 2, action: "Remove", requirementReference: id(50) },
    {
      ruleVersionReference: id(42),
      sequence: 1,
      action: "Replace",
      requirementReference: id(50),
      replacementRequirementReference: id(61),
      sourceKind: "SubRecipe",
      sourceReference: id(10),
      sourceVersionReference: id(11),
    },
  ];
  const modifiers = base.modifiers.map((m) => {
    const { selectedQuantity, ...facts } = m;
    void selectedQuantity;
    return {
      ...facts,
      changeCount:
        m.ruleVersionReference === id(41) ? 2 : m.ruleVersionReference === id(42) ? 1 : 0,
    };
  });
  return {
    generation: base.generation,
    observedAt: at,
    counts: {
      recipes: String(base.recipes.length),
      versions: String(base.versions.length),
      ingredients: String(ingredients.length),
      modifiers: String(modifiers.length),
      changes: String(changes.length),
    },
    recipes: base.recipes,
    versions: base.versions,
    ingredients,
    modifiers,
    changes,
  };
}
export const recipeInventoryMatchSource = (
  request: RecipeInventoryReferenceRequest,
  raw = recipeInventoryMatchRaw(),
  now = at,
) => buildRecipeInventoryReferenceSnapshot(raw, request, now);
