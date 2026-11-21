import { t } from "./i18n/i18n.js";
import type { MenuDish } from "./one-store-menu.js";
import { minorToDollars } from "./store-price-pages.js";

/**
 * WP-2423 M70: where a dish's price changes when it is edited on the menu page. At a Brand with one
 * Store there is one price. At several, the person chooses: this Store only (live at once, its own
 * price, recorded with who changed it) or every Store (the Brand price, live with "List it"; a
 * Store with its own price keeps it). What each person may do comes from the server.
 */
export interface DishPriceScopes {
  readonly severalStores: boolean;
  /** May change the Brand price of a dish that has one (one Store: price changes; several: the
   * Brand Owner). A new dish's first price is always for every Store. */
  readonly mayAllStores: boolean;
  /** May change this Store's own price (several Stores only). */
  readonly mayThisStore: boolean;
}
export const singleStorePrice: DishPriceScopes = {
  severalStores: false,
  mayAllStores: true,
  mayThisStore: false,
};

/** The dish's prices now, in cents: the Brand's, one waiting to be listed, and this Store's own. */
export interface PriceBasis {
  readonly brandPriceMinor: string | null;
  readonly pendingBrandPriceMinor: string | null;
  readonly storePriceMinor: string | null;
}
export const priceBasisOf = (dish: MenuDish | null): PriceBasis => ({
  brandPriceMinor: dish?.brandPriceMinor ?? null,
  pendingBrandPriceMinor: dish?.pendingBrandPriceMinor ?? null,
  storePriceMinor: dish?.storePriceMinor ?? null,
});
const brandOf = (basis: PriceBasis) => basis.pendingBrandPriceMinor ?? basis.brandPriceMinor;
/** What the price field starts from: at several Stores what this Store charges (or will). */
export const shownPrice = (basis: PriceBasis, severalStores: boolean): string | null =>
  severalStores ? (basis.storePriceMinor ?? brandOf(basis)) : brandOf(basis);
/** The price the person saw for the scope they chose (what the server compares with). */
export const expectedFor = (basis: PriceBasis, scope: "AllStores" | "ThisStore") =>
  scope === "ThisStore" ? (basis.storePriceMinor ?? basis.brandPriceMinor) : brandOf(basis);
/** The scopes this person may choose for this dish (a new dish: every Store only). */
export function priceScopeChoices(
  powers: DishPriceScopes,
  basis: PriceBasis,
  newDish: boolean,
): readonly ("AllStores" | "ThisStore")[] {
  if (!powers.severalStores) return ["AllStores"];
  const hasBrandPrice = !newDish && basis.brandPriceMinor !== null;
  return [
    ...(hasBrandPrice && powers.mayThisStore ? (["ThisStore"] as const) : []),
    ...(!hasBrandPrice || powers.mayAllStores ? (["AllStores"] as const) : []),
  ];
}
const amount = (value: unknown) =>
  value === null || (typeof value === "string" && /^(0|[1-9][0-9]{0,6})$/u.test(value));
/** The prices a save answered with (null: the answer had none, e.g. no price was sent). */
export function parseSavedPrice(value: unknown): PriceBasis | null {
  const r = value as Record<string, unknown> | null | undefined;
  if (
    r === null ||
    r === undefined ||
    typeof r !== "object" ||
    !amount(r.brandPriceMinor) ||
    !amount(r.pendingBrandPriceMinor) ||
    !amount(r.storePriceMinor)
  )
    return null;
  return {
    brandPriceMinor: r.brandPriceMinor as string | null,
    pendingBrandPriceMinor: r.pendingBrandPriceMinor as string | null,
    storePriceMinor: r.storePriceMinor as string | null,
  };
}
const money = (minor: string | null) => (minor === null ? null : "$" + minorToDollars(minor));

/** The price's scope at a Brand with several Stores: what it is now, and where a change goes. */
export function DishPriceScope({
  basis,
  choices,
  edited,
  chosen,
  onChoose,
}: {
  readonly basis: PriceBasis;
  readonly choices: readonly ("AllStores" | "ThisStore")[];
  readonly edited: boolean;
  readonly chosen: "AllStores" | "ThisStore" | null;
  readonly onChoose: (scope: "AllStores" | "ThisStore") => void;
}) {
  const own = money(basis.storePriceMinor);
  const brand = money(basis.brandPriceMinor);
  const waiting = money(basis.pendingBrandPriceMinor);
  return (
    <div className="dish-editor__price-scope">
      <p className="dish-editor__note">
        {own !== null
          ? t("This Store charges its own price, {own}.", { own })
          : brand !== null
            ? t("This Store charges the Brand price.")
            : t("No price yet. The first price is for every Store.")}{" "}
        {brand !== null ? t("Brand price: {brand}.", { brand }) : null}{" "}
        {waiting !== null ? t("{price} for every Store once listed.", { price: waiting }) : null}
      </p>
      {edited && choices.length > 1 ? (
        <fieldset className="dish-editor__scope">
          <legend>{t("Change the price")}</legend>
          <label>
            <input
              type="radio"
              name="price-scope"
              checked={chosen === "ThisStore"}
              onChange={() => onChoose("ThisStore")}
            />
            {t("Only at this Store — changes now")}
          </label>
          <label>
            <input
              type="radio"
              name="price-scope"
              checked={chosen === "AllStores"}
              onChange={() => onChoose("AllStores")}
            />
            {t("At every Store — when you List it")}
          </label>
        </fieldset>
      ) : null}
      {edited && choices.length === 1 ? (
        <p className="dish-editor__note">
          {choices[0] === "ThisStore"
            ? t("This changes the price at this Store only, now.")
            : t("This changes the price at every Store when you List it.")}
        </p>
      ) : null}
      {edited && chosen === "AllStores" && own !== null ? (
        <p className="dish-editor__problem" role="note">
          {t(
            "This Store keeps its own price {own}. To charge the new price here too, choose “Only at this Store”, or set it back to the Brand price on Prices.",
            { own },
          )}
        </p>
      ) : null}
      {edited && choices.length === 0 ? (
        <p className="dish-editor__problem" role="note">
          {t("You can't change this dish's price. Ask the owner or the Store's manager.")}
        </p>
      ) : null}
    </div>
  );
}
