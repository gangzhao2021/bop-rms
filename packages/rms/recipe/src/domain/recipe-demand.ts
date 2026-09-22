import {
  calculateRecipe,
  createRecipeSnapshot,
  validateRecipeGraph,
  RecipeError,
  type RecipeSnapshot,
  type UnitDimension,
} from "./recipe.js";
export interface RecipeInventoryDemand {
  readonly itemReference: string;
  readonly itemVersionReference: string;
  readonly unitDimension: UnitDimension;
  readonly quantityNumerator: string;
  readonly quantityDenominator: string;
  readonly sourcePath: readonly {
    recipeReference: string;
    versionReference: string;
    requirementReference: string;
  }[];
}
function fail(): never {
  throw new RecipeError("RECIPE_GRAPH_UNRESOLVED");
}
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const r = a % b;
    a = b;
    b = r;
  }
  return a;
}
function ratio(n: bigint, d: bigint): readonly [bigint, bigint] {
  if (n < 0n || d <= 0n) return fail();
  const divisor = gcd(n, d);
  return [n / divisor, d / divisor];
}
/** Pure theoretical demand, not inventory permission or an instruction to reserve/consume. */
export function calculateRecipeInventoryDemand(
  rootInput: RecipeSnapshot,
  availableInputs: readonly RecipeSnapshot[],
  requestedYieldMicrounits: string,
): readonly RecipeInventoryDemand[] {
  if (
    typeof requestedYieldMicrounits !== "string" ||
    !/^[1-9][0-9]{0,30}$/u.test(requestedYieldMicrounits) ||
    BigInt(requestedYieldMicrounits) > 10n ** 30n
  )
    return fail();
  const root = createRecipeSnapshot(rootInput),
    available = availableInputs.map(createRecipeSnapshot);
  validateRecipeGraph(root, available);
  const versions = new Map(available.map((s) => [s.versionReference, s]));
  const result: RecipeInventoryDemand[] = [];
  function visit(
    snapshot: RecipeSnapshot,
    n: bigint,
    d: bigint,
    path: RecipeInventoryDemand["sourcePath"],
  ): void {
    if (snapshot.lifecycle !== "Published") return fail();
    const calculated = calculateRecipe(snapshot);
    for (let i = 0; i < snapshot.ingredients.length; i++) {
      const ingredient = snapshot.ingredients[i],
        requirement = calculated.requirements[i];
      if (!ingredient || !requirement) return fail();
      const [amountN, amountD] = ratio(
        n * BigInt(requirement.baseQuantityMicrounits),
        d * BigInt(snapshot.yieldQuantityMicrounits),
      );
      const sourcePath = Object.freeze([
        ...path,
        Object.freeze({
          recipeReference: snapshot.recipeReference,
          versionReference: snapshot.versionReference,
          requirementReference: ingredient.requirementReference,
        }),
      ]);
      if (ingredient.sourceKind === "SubRecipe") {
        const child = versions.get(ingredient.sourceVersionReference);
        if (
          !child ||
          child.recipeReference !== ingredient.sourceReference ||
          child.yieldDimension !== ingredient.unitDimension
        )
          return fail();
        visit(child, amountN, amountD, sourcePath);
      } else {
        if (result.length >= 4096) return fail();
        result.push(
          Object.freeze({
            itemReference: ingredient.sourceReference,
            itemVersionReference: ingredient.sourceVersionReference,
            unitDimension: ingredient.unitDimension,
            quantityNumerator: amountN.toString(),
            quantityDenominator: amountD.toString(),
            sourcePath,
          }),
        );
      }
    }
  }
  visit(root, BigInt(requestedYieldMicrounits), 1n, []);
  return Object.freeze(result);
}
