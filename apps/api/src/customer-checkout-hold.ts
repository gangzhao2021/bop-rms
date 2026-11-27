import {
  CheckoutSessionServiceError,
  readForeignDiningCheckoutScope,
  type DiningCartCheckoutHoldPort,
} from "@rms/ordering";
import { createPostgresDiningCheckoutHoldSource, isDiningCheckoutHeld } from "@rms/dining";

/**
 * DEC-DINING-ANY-PARTICIPANT-SUBMIT: seconds until another guest's checkout of the table Cart
 * stops holding it (at least 1, at most an hour), for the Retry-After header.
 */
export function checkoutHoldRetrySeconds(heldUntil: string, now: string): number {
  const remaining = Date.parse(heldUntil) - Date.parse(now);
  if (!Number.isFinite(remaining)) return 60;
  return Math.min(3600, Math.max(1, Math.ceil(remaining / 1000)));
}

/**
 * Ordering's Cart edit/quote hold port: another participant's checkout of this Cart version
 * (Dining's public checkout-hold read), or, WP-2423 shared-table-checkout (a), another phone's
 * live choice of dishes on it at a pay-first table (checkout_scope_held, Ordering's own record):
 * until its reservation ends nobody else edits, quotes or checks out that version; once it ran out
 * the dishes are given back first. Either answers with the time to ask again.
 */
export function createCustomerDiningCheckoutHold(
  transactions: Parameters<typeof createPostgresDiningCheckoutHoldSource>[0],
  scope: Parameters<typeof createPostgresDiningCheckoutHoldSource>[1],
): DiningCartCheckoutHoldPort {
  const source = createPostgresDiningCheckoutHoldSource(transactions, scope);
  const owner = Object.freeze({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
  return Object.freeze({
    async read(input: Parameters<DiningCartCheckoutHoldPort["read"]>[0]) {
      const held = await source.read(input);
      if (held !== null) return held;
      const chosen = await transactions.run((tx) =>
        readForeignDiningCheckoutScope(tx as never, owner, {
          cartReference: input.cartReference,
          cartVersion: input.cartVersion,
          participantReference: input.participantReference,
          observedAt: input.observedAt,
        }),
      );
      return chosen === null ? null : Object.freeze({ heldUntil: chosen.heldUntil });
    },
  });
}

/** A Dining checkout preparation refused because another participant holds the Cart version
 * becomes the checkout-session refusal the customer sees; anything else is rethrown unchanged. */
export function rethrowCheckoutHeld(error: unknown): never {
  if (isDiningCheckoutHeld(error))
    throw new CheckoutSessionServiceError("CHECKOUT_IN_PROGRESS", error.heldUntil);
  throw error;
}
