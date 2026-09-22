import {
  createPostgresCartQueryStore,
  assertCartLifecycleActive,
  parseOrderingInstant,
  parseOrderingReference,
} from "@rms/ordering";
import type { CustomerCartSelectionInventoryOptions } from "./customer-cart-selection-inventory.js";

/** Additional Cart check inside the authenticated Pickup item command only.
 * Pickup retains credential, CSRF and registration validation before/after this
 * work. Context is supplied by Ordering, never accepted from an HTTP request.
 */
export function createCustomerPickupCartInventoryAuthorization(
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  now: () => string,
): CustomerCartSelectionInventoryOptions["authorize"] {
  const fixed = Object.freeze({
    brandReference: parseOrderingReference(scope.brandReference),
    storeReference: parseOrderingReference(scope.storeReference),
  });
  return async (transaction, input, context) => {
    try {
      const observedAt = parseOrderingInstant(input.observedAt);
      const startedAt = parseOrderingInstant(now());
      if (observedAt > startedAt || input.quantity !== context.quantity) return false;
      const cart = await createPostgresCartQueryStore(
        { run: (work) => work(transaction) },
        fixed,
      ).load(context.cartReference);
      const completedAt = parseOrderingInstant(now());
      if (
        cart === null ||
        completedAt < startedAt ||
        cart.aggregateVersion !== context.cartVersion ||
        cart.createdByActorReference !== context.guestSessionReference ||
        cart.orderType !== "Pickup" ||
        cart.diningSessionReference !== null ||
        !["Qr", "Web"].includes(cart.sourceChannel) ||
        cart.updatedAt > observedAt
      )
        return false;
      assertCartLifecycleActive(cart.lifecycle, completedAt);
      return true;
    } catch {
      return false;
    }
  };
}
