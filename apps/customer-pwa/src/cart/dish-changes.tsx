import { currentLanguage, t } from "../i18n/i18n.js";
import { allergensForChoice, compactAllergenLine } from "../menu/menu-families.js";
import type { MenuView } from "../menu/types.js";
import type { CheckoutQuote, DishRename } from "../checkout/types.js";
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
  /** v15 2026-11-11 b10: each language whose name changed, before and now (none: not known). */
  readonly renamed?: readonly DishRename[];
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
        ...(line.renamed === undefined ? {} : { renamed: line.renamed }),
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

/** Whether a menu language is the one the guest reads the menu in. */
const readsIn = (locale: string) =>
  currentLanguage() === "zh-Hans" ? /^zh\b/u.test(locale) : !/^zh\b/u.test(locale);
const languageName = (locale: string) =>
  /^zh\b/u.test(locale) ? t("Chinese") : /^en\b/u.test(locale) ? t("English") : null;

/**
 * v15 2026-11-11 b10: what the rename was, in words the guest can check — the name in their own
 * language before and now, or, when only another language's name changed, that name before and
 * now and that the name they read is the same.
 */
function renameText(change: DishChange): string {
  const renamed = change.renamed ?? [];
  const own = renamed.find((name) => readsIn(name.locale) && name.from !== "" && name.to !== "");
  if (own !== undefined) return t("{from} is now called {to}.", { from: own.from, to: own.to });
  const other = renamed.find((name) => !readsIn(name.locale) && name.to !== "");
  if (other === undefined)
    return t("{dish} was renamed since you added it.", { dish: change.dish });
  const language = languageName(other.locale);
  const sentence =
    other.from === ""
      ? language === null
        ? t("{dish} now has another name on the menu: {to}.", { dish: change.dish, to: other.to })
        : t("{dish} now has a {language} name: {to}.", {
            dish: change.dish,
            language,
            to: other.to,
          })
      : language === null
        ? t("{dish} was renamed on the menu from {from} to {to}.", {
            dish: change.dish,
            from: other.from,
            to: other.to,
          })
        : t("{dish}: its {language} name changed from {from} to {to}.", {
            dish: change.dish,
            language,
            from: other.from,
            to: other.to,
          });
  return (
    sentence +
    (currentLanguage() === "zh-Hans" ? "" : " ") +
    t("The name you see here is the same.")
  );
}

/** One plain sentence per changed dish: renamed, and its allergens as they are now. */
export function dishChangeText(change: DishChange): string {
  return [
    change.name ? renameText(change) : null,
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
