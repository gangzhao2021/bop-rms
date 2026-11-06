import type { LinePriceChange, PricedLine } from "../cart/seen-prices.js";
import type { CheckoutQuote } from "./types.js";

/** WP-2423 item 8 ⑦: what a Store never set offers (an older server sends no tips). */
export const defaultTips = Object.freeze({ enabled: true, tierPercents: [10, 15, 18] });

/**
 * WP-2423 M114: the tips the Store offers, known only once the order is priced. While pricing is
 * loading or failed nothing about tips is shown (a Store with tips off never flashes tip choices).
 */
export function checkoutTips(
  quote: Pick<CheckoutQuote, "tips"> | null,
): { readonly enabled: boolean; readonly tierPercents: readonly number[] } | null {
  return quote === null ? null : (quote.tips ?? defaultTips);
}

/** WP-2423 M74: the quote's line prices, as the lines the guest is charged for. */
export function quotePricedLines(quote: Pick<CheckoutQuote, "lines"> | null): PricedLine[] {
  return (quote?.lines ?? []).map((line) => ({
    cartItemReference: line.cartItemReference,
    quantity: line.quantity,
    amountMinor: BigInt(line.subtotal.amountMinor),
    currency: line.subtotal.currency,
  }));
}

/** WP-2423 M74: a rise must be accepted before paying; a decrease is only listed. */
export function priceChangesNeedAcceptance(changes: readonly LinePriceChange[]): boolean {
  return changes.some((change) => change.direction === "up");
}

/** WP-2423 M132: share of the subtotal above which a typed tip is confirmed first. */
export const largeTipPercent = 30n;

/**
 * WP-2423 M132: a tip the guest typed, against what it is a tip on (the subtotal before tax).
 * Above 30 % it is confirmed first; above the subtotal itself it is refused (the counter applies the
 * same ceiling), and the guest is told to ask staff to leave more.
 */
export function customTipCheck(
  tipMinor: string,
  subtotalMinor: string,
): "ok" | "confirm" | "too_large" {
  const tip = BigInt(tipMinor),
    base = BigInt(subtotalMinor);
  if (tip > base) return "too_large";
  return tip * 100n > base * largeTipPercent ? "confirm" : "ok";
}

/** WP-2423 M125: how long the confirmed prices are still held, as the page shows it. */
export function priceHold(
  expiresAt: string,
  nowMs: number,
): {
  readonly phase: "held" | "last-minute" | "ended";
  /** m:ss left (rounded up to the second). */
  readonly left: string;
  /** When the page should show it again (30 s steps above two minutes, then every second). */
  readonly nextUpdateMs: number | null;
} {
  const remaining = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0)
    return { phase: "ended", left: "0:00", nextUpdateMs: null };
  const seconds = Math.ceil(remaining / 1000);
  const left = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const sinceSecond = remaining - (seconds - 1) * 1000;
  const nextUpdateMs =
    remaining > 120_000
      ? Math.min(remaining - 120_000, ((seconds - 1) % 30) * 1000 + sinceSecond)
      : sinceSecond;
  return { phase: remaining <= 60_000 ? "last-minute" : "held", left, nextUpdateMs };
}
