import { t } from "../i18n/i18n.js";
import { allergensForChoice, compactAllergenLine } from "../menu/menu-families.js";
import type { MenuView } from "../menu/types.js";
import type { CheckoutQuote } from "../checkout/types.js";
import type { CartItemView } from "./types.js";
import { recordStoreFirstPrices, type PricedLine } from "./seen-prices.js";

/**
 * WP-2423 price-hold-dish-changes (DEC-PRICE-HOLD §3): a dish the restaurant renamed, or whose
 * allergens it changed, since this cart was first priced for it — as the Store says, so a reload or
 * another phone at the table finds it too. The guest is shown the dish as it is now and confirms
 * before ordering or paying (allergen safety before the confirmed price).
 */
export interface DishChange {
  readonly cartItemReference: string;
  readonly dish: string;
  readonly name: boolean;
  readonly allergens: boolean;
  /** The dish's allergen line as the menu states it now; null while the menu cannot say. */
  readonly allergensNow: string | null;
}

/**
 * A cart line's allergen line as the published menu states it now, with the guest's choices when
 * the menu says per choice. Null when the menu cannot say (not read yet, or the dish is not on it).
 */
export function lineAllergenLine(
  menu: MenuView | null,
  sellableReference: string,
  optionReferences: readonly string[],
): string | null {
  const sellable = menu?.sections
    .flatMap((section) => section.sellables)
    .find((candidate) => candidate.sellableReference === sellableReference);
  if (sellable === undefined) return null;
  const allergens =
    (optionReferences.length === 0 ? null : allergensForChoice(sellable, optionReferences)) ??
    sellable.allergens;
  return compactAllergenLine(allergens) ?? t("No allergens listed");
}

/** Whether the Store's answer names a dish renamed or given other allergens since it was added. */
export function hasDishChanges(quote: Pick<CheckoutQuote, "sinceAdded"> | null): boolean {
  return quote?.sinceAdded?.some((line) => line.changes.length > 0) === true;
}

/** The dishes the Store says changed since this cart was first priced for them. */
export function quoteDishChanges(
  quote: Pick<CheckoutQuote, "sinceAdded"> | null,
  items: readonly CartItemView[],
  menu: MenuView | null,
): readonly DishChange[] {
  return (quote?.sinceAdded ?? []).flatMap((line) => {
    const item = items.find((value) => value.cartItemReference === line.cartItemReference);
    if (item === undefined || line.changes.length === 0) return [];
    return [
      {
        cartItemReference: line.cartItemReference,
        dish: item.displayName,
        name: line.changes.includes("Name"),
        allergens: line.changes.includes("Allergens"),
        allergensNow: lineAllergenLine(
          menu,
          item.sellableReference,
          item.configuration.map((option) => option.optionReference),
        ),
      },
    ];
  });
}

/**
 * WP-2423 M74 with price-hold-dish-changes: what this cart was first priced at for each line is the
 * price the guest saw first, so a rise is named after a reload too (unless accepted on this page).
 */
export function recordFirstPricedLines(
  cartReference: string,
  quote: Pick<CheckoutQuote, "sinceAdded"> | null,
): void {
  const lines: PricedLine[] = (quote?.sinceAdded ?? []).map((line) => ({
    cartItemReference: line.cartItemReference,
    quantity: line.quantity,
    amountMinor: BigInt(line.subtotal.amountMinor),
    currency: line.subtotal.currency,
  }));
  if (lines.length > 0) recordStoreFirstPrices(cartReference, lines);
}

/** One plain sentence per changed dish: renamed, and its allergens as they are now. */
export function dishChangeText(change: DishChange): string {
  return [
    change.name ? t("{dish} was renamed since you added it.", { dish: change.dish }) : null,
    !change.allergens
      ? null
      : change.allergensNow === null
        ? t("{dish} allergens changed since you added it. Ask staff before you order.", {
            dish: change.dish,
          })
        : t("{dish} allergens now: {allergens}.", {
            dish: change.dish,
            allergens: change.allergensNow,
          }),
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

/** The dishes the restaurant changed since the guest added them, by name. */
export function DishChangeList({ changes }: { readonly changes: readonly DishChange[] }) {
  if (changes.length === 0) return null;
  return (
    <>
      <p>{t("Changed since you added it:")}</p>
      <ul className="checkout-price-changes">
        {changes.map((change) => (
          <li key={change.cartItemReference}>{dishChangeText(change)}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * What the guest confirms: a changed dish, or a price that went up (their signature). Dish changes
 * are ticked for the Store's quote that names them: a later quote (the dish changed again) is ticked
 * again.
 */
export function changesSignature(
  dishes: readonly DishChange[],
  priceRises: readonly { readonly cartItemReference: string; readonly afterMinor: bigint }[],
  quoteReference: string | null = null,
): string | null {
  return dishes.length === 0 && priceRises.length === 0
    ? null
    : JSON.stringify([
        dishes.length === 0 ? null : quoteReference,
        dishes.map((change) => [change.cartItemReference, change.name, change.allergens]),
        priceRises.map((change) => [change.cartItemReference, change.afterMinor.toString()]),
      ]);
}
