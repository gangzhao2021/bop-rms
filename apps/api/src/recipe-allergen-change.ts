import {
  currentAllergenRegistry,
  recordSellableAllergenChange,
  type SellableAllergenChange,
  type SellableAllergenChoiceChange,
  type SellableAllergenNow,
} from "@rms/catalog";
import { createMenuRecipeAllergenSource } from "./menu-recipe-allergen-source.js";

interface Tx {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/**
 * WP-2423 (M77, M167): right after a recipe is bound to a dish, or a Store's own recipe ends, in
 * the same transaction: the dish's allergens as now resolved at that Store (as normally ordered),
 * recorded so guests and the kitchen read them with the listed ones until the menu is listed
 * again. Inventory starts using the new recipe at once, so the listed list alone could leave an
 * allergen out. Allergens that cannot be resolved (an ingredient with no declaration) are
 * recorded as unknown, and readers ask guests and cooks to check with staff. Nothing is recorded
 * when the Brand has no allergen list.
 *
 * The caller already holds the permission for the binding; this only reads the recipe it just
 * bound and writes the change. A failed read is rolled back to its savepoint, never the binding.
 */
export async function recordRecipeAllergenChange(
  tx: unknown,
  input: {
    readonly scope: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
    };
    readonly skuReference: string;
    /** Null: a Brand-wide recipe (every Store). */
    readonly storeReference: string | null;
    readonly cause: SellableAllergenChange["cause"];
    readonly actorReference: string;
    readonly operationReference: string;
    readonly changeReference: string;
    readonly at: string;
    readonly locale: string;
    /**
     * WP-2423 (M166 with M77, b7): what each answered choice of the dish adds (by the choice
     * reference's last 12 characters, as its stand-in is named). Recorded with the dish's own in
     * `allergens` (the listed dish names every allergen a choice can add, so the change does too),
     * and apart, so guests read each under its choice and the kitchen only on a dish ordered with it.
     */
    readonly choiceAllergens?: Readonly<
      Record<
        string,
        readonly {
          readonly allergenReference: string;
          readonly classification: "Contains" | "CrossContactPossible";
        }[]
      >
    >;
  },
): Promise<{ readonly allergens: readonly SellableAllergenNow[] | null } | null> {
  const t = tx as Tx;
  const registry = await currentAllergenRegistry(t as never, input.scope);
  if (registry === null || registry.entries.length === 0) return null;
  const settings = (
    await t.query(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )
  ).rows[0];
  let allergens: SellableAllergenNow[] | null = null;
  let choices: SellableAllergenChoiceChange | undefined;
  await t.query("SAVEPOINT recipe_allergen_change", []);
  try {
    const resolved = await createMenuRecipeAllergenSource({
      brandReference: input.scope.brandReference,
      authorize: async () => true,
    }).resolve(t as never, {
      recipe: {
        actorType: "User",
        actorReference: input.actorReference,
        action: "ResolveMenuRecipeFacts",
        purpose: "ReviewMenu",
        brandReference: input.scope.brandReference,
        storeReference: input.scope.storeReference,
        skuReference: input.skuReference,
        observedAt: input.at,
        selections: [],
        // A Brand-wide change is read by every Store without its own recipe: resolve the Brand's
        // recipe, never the acting Store's own one.
        ...(input.storeReference === null ? { brandRecipeOnly: true } : {}),
      } as never,
      registryVersionReference: registry.registryVersionReference,
      defaultLocale: input.locale,
    });
    const strongest = new Map<string, "Contains" | "CrossContactPossible" | "Unverified">();
    for (const evidence of resolved.allergens.evidence)
      for (const assertion of evidence.assertions) {
        const before = strongest.get(String(assertion.allergenReference));
        if (before !== "Contains" && before !== "Unverified")
          strongest.set(String(assertion.allergenReference), assertion.classification);
      }
    const entries = (found: ReadonlyMap<string, string>) =>
      resolved.allergens.registry
        .filter((entry) => found.has(String(entry.allergenReference)))
        .map((entry) => ({
          allergenReference: String(entry.allergenReference),
          code: String(entry.code),
          localizedNames: entry.localizedNames,
          classification: found.get(String(entry.allergenReference)) as
            "Contains" | "CrossContactPossible",
        }));
    const own = new Map(strongest);
    const options: Record<string, SellableAllergenNow[]> = {};
    for (const [option, adds] of Object.entries(input.choiceAllergens ?? {})) {
      const mine = new Map<string, string>();
      for (const added of adds) {
        if (mine.get(added.allergenReference) !== "Contains")
          mine.set(added.allergenReference, added.classification);
        const before = strongest.get(added.allergenReference);
        if (before !== "Contains" && before !== "Unverified")
          strongest.set(added.allergenReference, added.classification);
      }
      if (mine.size > 0) options[option] = entries(mine);
    }
    if (![...strongest.values()].includes("Unverified")) {
      allergens = entries(strongest);
      if (input.choiceAllergens !== undefined) choices = { dish: entries(own), options };
    }
    await t.query("RELEASE SAVEPOINT recipe_allergen_change", []);
  } catch {
    await t.query("ROLLBACK TO SAVEPOINT recipe_allergen_change", []);
    allergens = null;
  }
  await t.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    settings?.brand ?? "",
    settings?.store ?? "",
  ]);
  await recordSellableAllergenChange(t as never, input.scope, {
    changeReference: input.changeReference,
    operationReference: input.operationReference,
    skuReference: input.skuReference,
    storeReference: input.storeReference,
    cause: input.cause,
    allergens,
    ...(choices === undefined ? {} : { choices }),
    actorReference: input.actorReference,
    recordedAt: input.at,
  });
  return { allergens };
}
