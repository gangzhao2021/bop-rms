import { CheckoutSessionServiceError, type DiningCartCheckoutHoldPort } from "@rms/ordering";
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

/** Ordering's Cart edit/quote hold port, answered by Dining's public checkout-hold read. */
export function createCustomerDiningCheckoutHold(
  transactions: Parameters<typeof createPostgresDiningCheckoutHoldSource>[0],
  scope: Parameters<typeof createPostgresDiningCheckoutHoldSource>[1],
): DiningCartCheckoutHoldPort {
  const source = createPostgresDiningCheckoutHoldSource(transactions, scope);
  return Object.freeze({
    read: (input: Parameters<DiningCartCheckoutHoldPort["read"]>[0]) => source.read(input),
  });
}

/** A Dining checkout preparation refused because another participant holds the Cart version
 * becomes the checkout-session refusal the customer sees; anything else is rethrown unchanged. */
export function rethrowCheckoutHeld(error: unknown): never {
  if (isDiningCheckoutHeld(error))
    throw new CheckoutSessionServiceError("CHECKOUT_IN_PROGRESS", error.heldUntil);
  throw error;
}
