import {
  createPostgresDiningCartCommandQueryStore,
  assertCartLifecycleActive,
  parseOrderingInstant,
  parseOrderingReference,
} from "@rms/ordering";
import type { CustomerCartSelectionInventoryOptions } from "./customer-cart-selection-inventory.js";

/** Additional Cart check inside the authenticated Dining item command only.
 * Dining retains credential, CSRF, registration and participant checks before/after this
 * work. Context is supplied by Ordering, never accepted from an HTTP request.
 */
export function createCustomerDiningCartInventoryAuthorization(
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
      if (context.diningSessionReference == null) return false;
      const cart = await createPostgresDiningCartCommandQueryStore(
        { run: (work) => work(transaction) },
        { ...fixed, diningSessionReference: context.diningSessionReference },
      ).load(context.cartReference);
      const completedAt = parseOrderingInstant(now());
      if (
        cart === null ||
        completedAt < startedAt ||
        cart.aggregateVersion !== context.cartVersion ||
        cart.orderType !== "DineIn" ||
        cart.diningSessionReference !== context.diningSessionReference ||
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
