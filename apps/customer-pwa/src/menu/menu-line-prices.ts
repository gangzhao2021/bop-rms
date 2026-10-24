import { useEffect, useMemo, useState } from "react";
import type { CartItemView } from "../cart/types.js";
import { createCustomerMenuClient } from "./menu-client.js";
import { decimalToMicros } from "./menu-families.js";
import type { CustomerMenuClient, MenuJourneyContext, MenuSellable, MenuView } from "./types.js";

/**
 * WP-2423: a cart line's price before tax, as the guest already saw it on the item page — the
 * size's published price plus each chosen option's published price, times the quantity — for lines
 * the Store has not priced yet (they are priced by the checkout quote). A line whose item or any
 * option is not on the current published menu, or not priced there, stays unpriced: no number is
 * shown for it rather than a guessed one. A line the Store already priced keeps that price.
 */
export interface CartLinePrice {
  readonly amountMinor: bigint;
  readonly currency: string;
}

const microsPerMinor = 10_000n;

function publishedLineMinor(
  item: CartItemView,
  sellable: MenuSellable | undefined,
): CartLinePrice | null {
  if (sellable === undefined || sellable.price === null) return null;
  const currency = sellable.price.currency;
  const base = decimalToMicros(sellable.price.amount);
  if (base === null) return null;
  const options = new Map(
    sellable.optionRules.flatMap((rule) =>
      rule.options.map((option) => [option.optionReference, option] as const),
    ),
  );
  let unit = base;
  for (const chosen of item.configuration) {
    const option = options.get(chosen.optionReference);
    if (option === undefined || option.price === null || option.price.currency !== currency)
      return null;
    const each = decimalToMicros(option.price.amount);
    if (each === null || !Number.isSafeInteger(chosen.quantity) || chosen.quantity < 0) return null;
    unit += each * BigInt(chosen.quantity);
  }
  const total = unit * BigInt(item.quantity);
  // Only whole cents are a price a guest can be charged; anything finer waits for the quote.
  if (total % microsPerMinor !== 0n) return null;
  return { amountMinor: total / microsPerMinor, currency };
}

/** Each line's price before tax, or null when it can't be stated (see above). */
export function cartLinePrices(
  items: readonly CartItemView[],
  menu: MenuView | null,
): ReadonlyMap<string, CartLinePrice | null> {
  const sellables = new Map(
    (menu?.sections ?? []).flatMap((section) =>
      section.sellables.map((sellable) => [sellable.sellableReference, sellable] as const),
    ),
  );
  return new Map(
    items.map((item) => {
      const estimate = item.lineEstimate;
      if (
        estimate.status === "Available" &&
        /^(?:0|[1-9][0-9]{0,20})$/u.test(estimate.total.amountMinor)
      )
        return [
          item.cartItemReference,
          { amountMinor: BigInt(estimate.total.amountMinor), currency: estimate.total.currency },
        ] as const;
      return [
        item.cartItemReference,
        publishedLineMinor(item, sellables.get(item.sellableReference)),
      ] as const;
    }),
  );
}

/**
 * Line prices that agree with the Store's quote: when a current quote exists and the lines'
 * published prices don't add up to its subtotal exactly, only the Store's own line prices are kept,
 * so a page never shows lines that disagree with the total beside them.
 */
export function quoteConsistentLinePrices(
  items: readonly CartItemView[],
  menu: MenuView | null,
  quoteSubtotal: { readonly amountMinor: string; readonly currency: string } | null,
): ReadonlyMap<string, CartLinePrice | null> {
  const prices = cartLinePrices(items, menu);
  if (quoteSubtotal === null) return prices;
  const sum = cartLinesSubtotal(prices);
  if (
    sum !== null &&
    sum.currency === quoteSubtotal.currency &&
    /^(?:0|[1-9][0-9]{0,20})$/u.test(quoteSubtotal.amountMinor) &&
    sum.amountMinor === BigInt(quoteSubtotal.amountMinor)
  )
    return prices;
  return cartLinePrices(items, null);
}

/** The sum of every line's price, or null when any line is unpriced or currencies differ. */
export function cartLinesSubtotal(
  prices: ReadonlyMap<string, CartLinePrice | null>,
): CartLinePrice | null {
  let total = 0n;
  let currency: string | null = null;
  for (const price of prices.values()) {
    if (price === null || (currency !== null && price.currency !== currency)) return null;
    currency = price.currency;
    total += price.amountMinor;
  }
  return currency === null ? null : { amountMinor: total, currency };
}

/**
 * The published menu, read only when some line still needs it. Null while loading, when there is
 * no Store context, or when the menu can't be read (lines then stay unpriced).
 */
export function usePublishedMenu(
  context: MenuJourneyContext | undefined,
  client: CustomerMenuClient | undefined,
  needed: boolean,
): MenuView | null {
  const resolved = useMemo(() => {
    if (client !== undefined) return client;
    if (context === undefined) return null;
    return createCustomerMenuClient(context, {
      fetch: globalThis.fetch.bind(globalThis),
      online: () => globalThis.navigator?.onLine ?? true,
    });
  }, [client, context]);
  const [menu, setMenu] = useState<MenuView | null>(null);
  useEffect(() => {
    if (!needed || resolved === null) return;
    let active = true;
    void resolved
      .load({})
      .then((result) => {
        if (active) setMenu(result.kind === "Found" ? result.menu : null);
      })
      .catch(() => {
        if (active) setMenu(null);
      });
    return () => {
      active = false;
    };
  }, [needed, resolved]);
  return needed ? menu : null;
}
