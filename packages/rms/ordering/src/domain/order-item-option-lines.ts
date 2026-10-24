import type { OrderItemTransactionSnapshot, OrderSnapshotMoney } from "./order-item-snapshot.js";

/** One chosen option of a frozen Order item, as the guest saw it in the cart and checkout. */
export interface OrderItemOptionLine {
  readonly displayName: string;
  /** How many of this option were chosen for each item ("Extra shot × 2"). */
  readonly quantity: number;
  /** What the option added to the item's price for the whole line (zero when it is free). */
  readonly amount: OrderSnapshotMoney;
}

/**
 * A frozen catalog name in the first of `locales` it has (Owner 2026-10-23: the guest's chosen
 * language, then the session language): the exact locale, then the same language, and otherwise
 * any name it has, so a guest never sees an item or option without a name. Chosen at read time
 * from the names frozen at checkout; the frozen snapshot is never rewritten.
 */
export function orderLocalizedName(
  names: Readonly<Record<string, string>>,
  locales: string | readonly string[],
): string {
  const preferred = (typeof locales === "string" ? [locales] : locales).filter(
    (locale) => locale.length > 0,
  );
  const usable = (value: string | undefined) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  for (const locale of preferred) {
    const language = locale.split("-")[0] ?? locale;
    const name =
      usable(names[locale]) ??
      usable(names[language]) ??
      usable(
        Object.entries(names).find(
          ([key, value]) => key.split("-")[0] === language && usable(value),
        )?.[1],
      );
    if (name !== undefined) return name;
  }
  const name = Object.values(names).find((value) => usable(value) !== undefined);
  if (name === undefined) throw new Error("invalid Order item name");
  return name;
}

/**
 * WP-2423: the chosen options of one frozen Order item with what each added to its price, in the
 * order the guest chose them. Read only from the item's transaction snapshot (the catalog options
 * captured at checkout and, for configured quotes, each option's frozen price), never from the
 * current menu. Items priced before option prices existed carry options at no extra charge.
 */
export function orderItemOptionLines(
  snapshot: OrderItemTransactionSnapshot<1> | OrderItemTransactionSnapshot<2>,
  locale: string | readonly string[],
): readonly OrderItemOptionLine[] {
  const currencyCode = snapshot.pricing.subtotal.currencyCode;
  const prices =
    "optionPrices" in snapshot.pricing
      ? (snapshot.pricing as OrderItemTransactionSnapshot<2>["pricing"]).optionPrices
      : [];
  let total = 0n;
  const lines = snapshot.catalog.options.map((option) => {
    const price = prices.find((entry) => entry.optionReference === option.optionReference);
    if (price !== undefined && price.subtotal.currencyCode !== currencyCode)
      throw new Error("invalid Order option price");
    const amountMinor = price?.subtotal.amountMinor ?? 0n;
    total += amountMinor;
    return Object.freeze({
      displayName: orderLocalizedName(option.localizedNames, locale),
      quantity: option.quantity,
      amount: Object.freeze({ amountMinor, currencyCode }),
    });
  });
  if (
    prices.some(
      (price) =>
        !snapshot.catalog.options.some(
          (option) => option.optionReference === price.optionReference,
        ),
    ) ||
    total > snapshot.pricing.subtotal.amountMinor
  )
    throw new Error("invalid Order option price");
  return Object.freeze(lines);
}
