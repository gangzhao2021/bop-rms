import { t } from "../i18n/i18n.js";
import { formatMoney } from "../journey/format.js";
import type { CartItemView } from "../cart/types.js";
import type { LinePriceChange } from "../cart/seen-prices.js";

/** WP-2423 M74: one plain sentence per dish whose price changed since the guest added it. */
export function priceChangeText(change: LinePriceChange, dish: string): string {
  const before = formatMoney(change.beforeMinor.toString(), change.currency);
  const after = formatMoney(change.afterMinor.toString(), change.currency);
  return change.direction === "up"
    ? t("{dish}: {old} → {new}", { dish, old: before, new: after })
    : t("{dish}: now {new}, was {old}", { dish, old: before, new: after });
}

/** WP-2423 M74: the dishes whose price changed since they were added, by name, old and new. */
export function PriceChangeList({
  changes,
  items,
}: {
  readonly changes: readonly LinePriceChange[];
  readonly items: readonly CartItemView[];
}) {
  if (changes.length === 0) return null;
  const names = new Map(items.map((item) => [item.cartItemReference, item.displayName]));
  return (
    <>
      <p>{t("Prices changed since you added these:")}</p>
      <ul className="checkout-price-changes">
        {changes.map((change) => (
          <li key={change.cartItemReference}>
            {priceChangeText(change, names.get(change.cartItemReference) ?? t("A dish"))}
          </li>
        ))}
      </ul>
    </>
  );
}
