import { readClosedRecord } from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
} from "./cart.js";
import { decideInitialDiningCartSelection } from "./dining-cart-selection.js";

/** Pure successor preparation, never a write lease or a current-cart selection.
 * The writer must prove the predecessor is current, retain Dining/Checkout/Payment
 * clearance fences, and append replacement + Audit atomically with the new Cart.
 * Expiration must already be recorded through its owner command. No implicit
 * expiration, resurrection, item transfer, quote reuse or submitted Batch change.
 */
export function prepareDiningCartReplacement(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "previousCart",
      "expectedCartVersion",
      "brandReference",
      "storeReference",
      "diningSessionReference",
      "guestSessionReference",
      "participantReference",
      "observedAt",
      "creation",
    ]);
    const previous = parseCartAggregate(raw.previousCart);
    const observedAt = parseOrderingInstant(raw.observedAt);
    const brandReference = parseOrderingReference(raw.brandReference);
    const storeReference = parseOrderingReference(raw.storeReference);
    const diningSessionReference = parseOrderingReference(raw.diningSessionReference);
    if (
      previous.brandReference !== brandReference ||
      previous.storeReference !== storeReference ||
      previous.diningSessionReference !== diningSessionReference ||
      previous.orderType !== "DineIn" ||
      !["Qr", "Web"].includes(previous.sourceChannel) ||
      previous.aggregateVersion !== raw.expectedCartVersion ||
      previous.updatedAt > observedAt
    )
      throw new CartError("CART_VERSION_CONFLICT");
    if (
      previous.lifecycle === null ||
      previous.lifecycle.status === "Active" ||
      previous.lifecycle.terminalAt === null ||
      previous.lifecycle.terminalAt > observedAt
    )
      throw new CartError("CART_LIFECYCLE_UNAVAILABLE");
    const successor = decideInitialDiningCartSelection({
      brandReference,
      storeReference,
      diningSessionReference,
      guestSessionReference: raw.guestSessionReference,
      participantReference: raw.participantReference,
      observedAt,
      history: [],
      creation: raw.creation,
    });
    if (
      successor.cart.cartReference === previous.cartReference ||
      successor.cart.sourceChannel !== previous.sourceChannel
    )
      throw new CartError("CART_INPUT_INVALID");
    return Object.freeze({
      previousCartReference: previous.cartReference,
      previousCartVersion: previous.aggregateVersion,
      cart: successor.cart,
      guestSessionReference: successor.guestSessionReference,
      participantReference: successor.participantReference,
      observedAt,
    });
  } catch (error) {
    if (error instanceof CartError) throw error;
    throw new CartError("CART_INPUT_INVALID");
  }
}
