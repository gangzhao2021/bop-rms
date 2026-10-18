import { currentAllergenRegistry, listCurrentIngredientDeclarations } from "@rms/catalog";
import { listInventoryRecipeIngredientFacts } from "@rms/inventory";
import type { RecipeDraftFacts } from "@rms/recipe";

/**
 * WP-2423 / DEC-ALLERGEN-DECLARATIONS: the Brand's stock-tracked inventory items a recipe may use,
 * each with its current allergen declaration for its current version and the current registry
 * (null when it has none), as the Recipe facts recipes and option recipe changes are built from.
 * Caller authorizes and owns the transaction.
 */
export async function recipeIngredientItems(
  tx: unknown,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  at: string,
) {
  const items = await listInventoryRecipeIngredientFacts(tx as never, scope);
  const registry = await currentAllergenRegistry(tx as never, scope);
  const declarations = new Map(
    (await listCurrentIngredientDeclarations(tx as never, scope, at))
      .filter((d) => d.registryVersionReference === registry?.registryVersionReference)
      .map((d) => [d.itemReference, d]),
  );
  const declarationOf = (item: (typeof items)[number]) => {
    const d = declarations.get(item.itemReference);
    return d !== undefined && d.itemVersionReference === item.configurationOperationReference
      ? d
      : null;
  };
  const facts: RecipeDraftFacts["items"] = new Map(
    items
      .filter((item) => item.stockTracked)
      .map((item) => {
        const d = declarationOf(item);
        return [
          item.itemReference,
          {
            configurationOperationReference: item.configurationOperationReference,
            dimension: item.dimension,
            unitCode: item.unitCode,
            active: item.active,
            allergenDeclaration:
              d === null
                ? null
                : {
                    evidenceReference: d.evidenceReference,
                    allergenReferences: d.allergens.map((a) => a.allergenReference),
                  },
          },
        ];
      }),
  );
  return { items, registry, declarations, declarationOf, facts };
}
