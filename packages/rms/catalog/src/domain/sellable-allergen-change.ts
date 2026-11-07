/**
 * WP-2423 (M77, M167): a dish's allergens as resolved right after a recipe was bound to it or a
 * Store's own recipe ended (Inventory uses the new recipe at once). The listed menu still names
 * what was reviewed; until it is listed again, readers show both together, so what guests and the
 * kitchen read never leaves an allergen out.
 */
export type SellableAllergenClassification = "Contains" | "CrossContactPossible";
export interface SellableAllergenNow {
  readonly allergenReference: string;
  readonly code: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly classification: SellableAllergenClassification;
}
export interface SellableAllergenChange {
  readonly skuReference: string;
  /** Null: every Store of the Brand. */
  readonly storeReference: string | null;
  readonly cause: "RecipeBound" | "RecipeEnded";
  /** Null: the dish's allergens could not be resolved after the change (staff are asked). */
  readonly allergens: readonly SellableAllergenNow[] | null;
  readonly recordedAt: string;
}

/**
 * The listed allergens together with the change's: every allergen of either, "Contains" kept over
 * "May contain". `changed` says the change adds an allergen or makes one stronger, so readers
 * say the information was just updated; a change that only removes one changes nothing shown
 * (the listed list stays until the menu is listed again). A change whose allergens could not be
 * resolved keeps the listed list and is always `changed`.
 */
export function withSellableAllergenChange<
  T extends { readonly code: string; readonly classification: SellableAllergenClassification },
>(
  listed: readonly T[],
  change: Pick<SellableAllergenChange, "allergens"> | undefined,
  entry: (allergen: SellableAllergenNow) => T,
): { readonly items: readonly T[]; readonly changed: boolean } {
  if (change === undefined) return { items: listed, changed: false };
  if (change.allergens === null) return { items: listed, changed: true };
  const items = [...listed];
  let changed = false;
  for (const allergen of change.allergens) {
    const at = items.findIndex((item) => item.code === allergen.code);
    const current = at < 0 ? undefined : items[at];
    if (current === undefined) {
      items.push(entry(allergen));
      changed = true;
    } else if (current.classification !== "Contains" && allergen.classification === "Contains") {
      items[at] = entry(allergen);
      changed = true;
    }
  }
  return { items: Object.freeze(items), changed };
}
