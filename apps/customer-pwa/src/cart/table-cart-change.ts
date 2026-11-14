import type { CartRoundPaymentState, CartView } from "./types.js";

/**
 * WP-2423 (same-table-ordering): what happened to a table cart since this phone loaded it, from
 * two cart views: nothing; changed by someone at the table (with the dishes added); or its dishes
 * left in a round someone at the table paid for (by the round's own record of the cart lines it
 * took, whatever was added after). Never names who.
 */
export interface TableCartDish {
  readonly displayName: string;
  readonly quantity: number;
}

const nothing: readonly TableCartDish[] = Object.freeze([]);

export type TableCartChange =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "changed";
      /** New dishes, and the extra of a dish already there. */
      readonly added: readonly TableCartDish[];
      /** Dishes no longer in the cart (not taken by a round), with the quantity they had. */
      readonly removed: readonly TableCartDish[];
      /** Dishes still there with a smaller quantity: `quantity` is the new one. Increases are in `added`. */
      readonly reduced: readonly TableCartDish[];
      /**
       * v15 batch 7: of `removed`, the dishes staff took out (the cart's own record of staff
       * removals); absent when none. Never said to be done by "someone at your table".
       */
      readonly byStaff?: readonly TableCartDish[];
    }
  | {
      /**
       * v15 batch 7 (DEC-DINING-CHECKOUT-SCOPE 15): this phone had chosen which dishes it pays for
       * this round, and the cart changed before it started paying (staff took a dish out, or the
       * others' dishes came back after the reservation ended). Its choice is over: it chooses
       * again, never checks out the whole cart on the old choice.
       */
      readonly kind: "choiceEnded";
      /** Dishes staff took out meanwhile (empty when it was not staff). */
      readonly byStaff: readonly TableCartDish[];
    }
  | {
      readonly kind: "sent";
      readonly roundNumber: number;
      readonly byThisPhone: boolean;
      /** WP-2423 M38: where that round's payment stands (null: not said). */
      readonly paymentState: CartRoundPaymentState | null;
      /** v15 batch-5: staff entered that round and take its payment on the card machine. */
      readonly enteredByStaff: boolean;
      /** Dishes are in the cart again (added after that round). */
      readonly cartHasDishes: boolean;
    };

export function tableCartChange(loaded: CartView, current: CartView | null): TableCartChange {
  if (current !== null && current.cart.cartReference !== loaded.cart.cartReference)
    return Object.freeze({ kind: "changed", added: nothing, removed: nothing, reduced: nothing });
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
        paymentState: round.paymentState,
        enteredByStaff: round.enteredByStaff === true,
        cartHasDishes: (current?.cart.items.length ?? 0) > 0,
      });
  }
  // v15 batch 7: the dishes staff took out since this phone loaded the cart, by the cart's own
  // record of staff removals (matched to the removed lines by name).
  const knownRemovals = new Set(
    (loaded.cart.staffRemoved ?? []).map((entry) => entry.removedAt + "|" + entry.quantity),
  );
  const staffNames = (current?.cart.staffRemoved ?? [])
    .filter((entry) => !knownRemovals.has(entry.removedAt + "|" + entry.quantity))
    .map((entry) => new Set(Object.values(entry.names)));
  const byStaffOf = (dishes: readonly TableCartDish[]) =>
    dishes.filter((dish) => {
      const index = staffNames.findIndex((names) => names.has(dish.displayName));
      if (index < 0) return false;
      staffNames.splice(index, 1);
      return true;
    });
  if (
    loaded.cart.tablePay?.payer?.thisPhone === true &&
    current !== null &&
    // Ended whether nobody holds the choice now or another phone chose before this one read again.
    current.cart.tablePay?.payer?.thisPhone !== true
  ) {
    const gone = loaded.cart.items
      .filter((item) => !now.has(item.cartItemReference))
      .map((item) => ({ displayName: item.displayName, quantity: item.quantity }));
    const lower = loaded.cart.items.flatMap((item) => {
      const left = now.get(item.cartItemReference)?.quantity;
      return left !== undefined && left < item.quantity
        ? [{ displayName: item.displayName, quantity: item.quantity - left }]
        : [];
    });
    return Object.freeze({
      kind: "choiceEnded",
      byStaff: Object.freeze(byStaffOf([...gone, ...lower]).map((dish) => Object.freeze(dish))),
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
  // WP-2423 (shared-table-cart-staff-round, M37): name removals and smaller quantities too, so a
  // guest reads what changed, not only that something did. A line a round took is not "removed".
  const removed = gone
    .filter((item) => takenBy(item.cartItemReference) === undefined)
    .map((item) => Object.freeze({ displayName: item.displayName, quantity: item.quantity }));
  const reduced = (current?.cart.items ?? [])
    .filter((item) => {
      const was = before.get(item.cartItemReference);
      return was !== undefined && item.quantity < was;
    })
    .map((item) => Object.freeze({ displayName: item.displayName, quantity: item.quantity }));
  const byStaff = byStaffOf(removed);
  return Object.freeze({
    kind: "changed",
    added: Object.freeze(added),
    removed: Object.freeze(removed.filter((dish) => !byStaff.includes(dish))),
    reduced: Object.freeze(reduced),
    ...(byStaff.length === 0 ? {} : { byStaff: Object.freeze(byStaff) }),
  });
}
