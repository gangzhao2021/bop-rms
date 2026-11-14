/**
 * WP-2423 M74: the price of each cart line as this guest was shown it, so checkout can say which
 * dishes changed price since they were added ("Jasmine green tea: $5.49 → $5.99") instead of only
 * a new total.
 *
 * A line's price is recorded the first time the guest sees it (when it is added, or the first time
 * the cart shows it) and is replaced only when the guest has been shown the change and accepted
 * it. Showing a priced line again never overwrites it, so a reload or a second look at the cart
 * still finds the rise. Prices are compared per unit (line amount ÷ quantity, options included),
 * so a line whose quantity the guest changed is still compared.
 *
 * Held in this page's memory only (prices, never contact or payment data), per the customer
 * app's rule against persisting transaction data in the browser: a full reload starts afresh, and
 * the page then simply has no earlier price to compare with.
 */
export interface SeenLinePrice {
  readonly amountMinor: bigint;
  readonly quantity: number;
  readonly currency: string;
}

export interface PricedLine {
  readonly cartItemReference: string;
  readonly quantity: number;
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface LinePriceChange {
  readonly cartItemReference: string;
  /** What the line cost at its current quantity when the guest saw it. */
  readonly beforeMinor: bigint;
  /** What it costs now. */
  readonly afterMinor: bigint;
  readonly currency: string;
  readonly direction: "up" | "down";
}

const seen = new Map<string, Map<string, SeenLinePrice>>();
/** Lines whose price the guest accepted on this page, by cart. */
const accepted = new Map<string, Set<string>>();

function valid(line: PricedLine): boolean {
  return (
    Number.isSafeInteger(line.quantity) &&
    line.quantity > 0 &&
    line.amountMinor >= 0n &&
    /^[A-Z]{3}$/u.test(line.currency)
  );
}

function cartPrices(cartReference: string): Map<string, SeenLinePrice> {
  let prices = seen.get(cartReference);
  if (prices === undefined) {
    prices = new Map();
    seen.set(cartReference, prices);
  }
  return prices;
}

/** The first price the guest is shown for each line; a line already recorded keeps its price. */
export function recordFirstSeenPrices(cartReference: string, lines: readonly PricedLine[]): void {
  const prices = cartPrices(cartReference);
  for (const line of lines)
    if (valid(line) && !prices.has(line.cartItemReference))
      prices.set(line.cartItemReference, {
        amountMinor: line.amountMinor,
        quantity: line.quantity,
        currency: line.currency,
      });
}

/** The guest was shown these prices and accepted them: they are now what the guest saw. */
export function acceptSeenPrices(cartReference: string, lines: readonly PricedLine[]): void {
  const prices = cartPrices(cartReference);
  const kept = accepted.get(cartReference) ?? new Set<string>();
  accepted.set(cartReference, kept);
  for (const line of lines) kept.add(line.cartItemReference);
  for (const line of lines)
    if (valid(line))
      prices.set(line.cartItemReference, {
        amountMinor: line.amountMinor,
        quantity: line.quantity,
        currency: line.currency,
      });
}

/**
 * WP-2423 price-hold-dish-changes: the Store's own record of what this cart was first priced at for
 * these lines (on any phone, before any reload) is what the guest first saw. It replaces what this
 * page recorded first, unless the guest has accepted a price for the line here since.
 */
export function recordStoreFirstPrices(cartReference: string, lines: readonly PricedLine[]): void {
  const prices = cartPrices(cartReference);
  const kept = accepted.get(cartReference);
  for (const line of lines)
    if (valid(line) && kept?.has(line.cartItemReference) !== true)
      prices.set(line.cartItemReference, {
        amountMinor: line.amountMinor,
        quantity: line.quantity,
        currency: line.currency,
      });
}

/** Lines whose price per unit differs from the one the guest saw (lines never seen are left out). */
export function seenPriceChanges(
  cartReference: string,
  lines: readonly PricedLine[],
): readonly LinePriceChange[] {
  const prices = seen.get(cartReference);
  if (prices === undefined) return [];
  const changes: LinePriceChange[] = [];
  for (const line of lines) {
    const before = prices.get(line.cartItemReference);
    if (before === undefined || !valid(line) || before.currency !== line.currency) continue;
    // Per unit, without division: before / beforeQty versus after / afterQty.
    const was = before.amountMinor * BigInt(line.quantity);
    const now = line.amountMinor * BigInt(before.quantity);
    if (was === now) continue;
    const quantity = BigInt(before.quantity);
    // The earlier unit price at today's quantity, to the nearest cent.
    const beforeMinor = (was * 2n + quantity) / (2n * quantity);
    changes.push({
      cartItemReference: line.cartItemReference,
      beforeMinor,
      afterMinor: line.amountMinor,
      currency: line.currency,
      direction: now > was ? "up" : "down",
    });
  }
  return changes;
}

/** Test seam: forget every recorded price. */
export function clearSeenPrices(): void {
  seen.clear();
  accepted.clear();
}
