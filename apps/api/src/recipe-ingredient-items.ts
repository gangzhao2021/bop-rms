import { currentAllergenRegistry, listCurrentIngredientDeclarations } from "@rms/catalog";
import { listInventoryRecipeIngredientFacts } from "@rms/inventory";
import { listStaffDeclaredAllergenSources, type RecipeDraftFacts } from "@rms/recipe";

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
  /**
   * WP-2423 item 8 ⑥ part 4 (v15 2026-10-29): also the items holding a dish's allergens declared by
   * staff (labelled AllergensDeclaredByStaff, never stock-tracked), which a combo's choice adds.
   * They stay out of stock and costing: not stock-tracked, no cost.
   */
  options: { readonly staffDeclared?: boolean } = {},
) {
  const staffItems = new Set<string>();
  if (options.staffDeclared === true) {
    for (const source of await listStaffDeclaredAllergenSources(tx as never, scope))
      if (source.subject === "Dish") staffItems.add(source.itemReference);
    // The Recipe read leaves the transaction at the Brand; the store's reads continue.
    await (tx as { query(sql: string, values: unknown[]): Promise<unknown> }).query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [scope.brandReference, scope.storeReference],
    );
  }
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
      .filter((item) => item.stockTracked || staffItems.has(item.itemReference))
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
