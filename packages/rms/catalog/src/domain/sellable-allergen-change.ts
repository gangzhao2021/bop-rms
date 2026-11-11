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
  /** WP-2423: StaffDeclared — staff changed a listed dish's allergen answers on the Menu page. */
  readonly cause: "RecipeBound" | "RecipeEnded" | "StaffDeclared";
  /** Null: the dish's allergens could not be resolved after the change (staff are asked). */
  readonly allergens: readonly SellableAllergenNow[] | null;
  /**
   * WP-2423 (M166 with M77, b7; 2000_680): when staff answered choices, which of `allergens` are
   * the dish's own and what each choice adds (keyed by `sellableAllergenChoiceKey`). `allergens` still holds them
   * all, so a reader that knows nothing of choices never leaves one out. Absent otherwise.
   */
  readonly choices?: SellableAllergenChoiceChange;
  readonly recordedAt: string;
}
/** A choice's key in `choices.options`: its option reference's last 12 characters (lower case). */
export const sellableAllergenChoiceKey = (optionReference: string) =>
  optionReference.slice(-12).toLowerCase();
export interface SellableAllergenChoiceChange {
  readonly dish: readonly SellableAllergenNow[];
  /**
   * What each answered choice adds; an empty list is a choice staff answered "Adds none" (told
   * apart from one never answered, which is absent).
   */
  readonly options: Readonly<Record<string, readonly SellableAllergenNow[]>>;
}
/**
 * The most choices one change says something about: every choice the dish editor can put on a
 * dish (12 sets of 50). A change about more is recorded without `choices` (the dish's list still
 * names every allergen), and a stored one about more is read the same way, never refused.
 */
export const SELLABLE_ALLERGEN_CHOICE_LIMIT = 600;

/**
 * WP-2423 (b7): the change as it reaches one dish ordered with these choices — the dish's own
 * allergens with what the chosen ones add. Unknown choices (null), or a change that does not say
 * what each choice adds, keep the whole change, so it never leaves an allergen out.
 */
export function sellableAllergenChangeForChoices<T extends SellableAllergenChange>(
  change: T | undefined,
  chosen: readonly string[] | null,
): T | undefined {
  if (change === undefined || change.allergens === null || change.choices === undefined)
    return change;
  if (chosen === null) return change;
  const merged = new Map<string, SellableAllergenNow>();
  for (const allergen of [
    ...change.choices.dish,
    ...chosen.flatMap((option) => change.choices?.options[sellableAllergenChoiceKey(option)] ?? []),
  ]) {
    const before = merged.get(allergen.code);
    if (
      before === undefined ||
      (before.classification !== "Contains" && allergen.classification === "Contains")
    )
      merged.set(allergen.code, allergen);
  }
  return { ...change, allergens: Object.freeze([...merged.values()]) };
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
