import type { CartView } from "./types.js";

/**
 * WP-2423 (same-table-ordering): what happened to a table cart since this phone loaded it, from
 * two cart views: nothing; changed by someone at the table (with the dishes added); or its dishes
 * left in a round someone at the table paid for (by the round's own record of the cart lines it
 * took, whatever was added after). Never names who.
 */
export type TableCartChange =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "changed";
      readonly added: readonly { readonly displayName: string; readonly quantity: number }[];
    }
  | {
      readonly kind: "sent";
      readonly roundNumber: number;
      readonly byThisPhone: boolean;
      /** Dishes are in the cart again (added after that round). */
      readonly cartHasDishes: boolean;
    };

export function tableCartChange(loaded: CartView, current: CartView | null): TableCartChange {
  if (current !== null && current.cart.cartReference !== loaded.cart.cartReference)
    return Object.freeze({ kind: "changed", added: Object.freeze([]) });
  if (current !== null && current.cart.version === loaded.cart.version)
    return Object.freeze({ kind: "unchanged" });
  const now = new Map((current?.cart.items ?? []).map((item) => [item.cartItemReference, item]));
  const gone = loaded.cart.items.filter((item) => !now.has(item.cartItemReference));
  const rounds = current?.cart.recentRounds ?? [];
  const takenBy = (reference: string) =>
    rounds.find((round) => round.cartItemReferences.includes(reference));
  const taken = gone.map((item) => takenBy(item.cartItemReference));
  if (
    loaded.cart.items.length > 0 &&
    gone.length === loaded.cart.items.length &&
    taken.every((round) => round !== undefined)
  ) {
    const round = taken.reduce((latest, candidate) =>
      candidate !== undefined && latest !== undefined && candidate.roundNumber > latest.roundNumber
        ? candidate
        : latest,
    );
    if (round !== undefined)
      return Object.freeze({
        kind: "sent",
        roundNumber: round.roundNumber,
        byThisPhone: round.sentByThisPhone,
        cartHasDishes: (current?.cart.items.length ?? 0) > 0,
      });
  }
  const before = new Map(loaded.cart.items.map((item) => [item.cartItemReference, item.quantity]));
  const added = (current?.cart.items ?? [])
    .map((item) => ({
      displayName: item.displayName,
      quantity: item.quantity - (before.get(item.cartItemReference) ?? 0),
    }))
    .filter((line) => line.quantity > 0)
    .map((line) => Object.freeze(line));
  return Object.freeze({ kind: "changed", added: Object.freeze(added) });
}
