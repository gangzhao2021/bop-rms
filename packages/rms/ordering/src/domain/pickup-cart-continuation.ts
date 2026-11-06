import { readClosedRecord } from "@bop/identity";
import { CartError, parseCartAggregate, parseOrderingReference } from "./cart.js";
import { advanceCartLifecycle } from "./cart-lifecycle.js";
import { parseOrderBatch } from "./order.js";

/**
 * WP-2423 M03: pure transition after an exact successful pickup submission, the pickup twin of
 * `clearSubmittedDiningCart`. The ordered dishes leave the Cart (they stay in the append-only
 * OrderItem snapshots, which name their source Cart line) and the Cart moves to its next version,
 * so the same dishes can never be checked out and paid a second time. Persist with the Order in one
 * owner transaction. Calling this proves neither that an Order was persisted nor current authority.
 */
export function clearSubmittedPickupCart(value: unknown) {
  const raw = readClosedRecord(value, [
    "cart",
    "batch",
    "brandReference",
    "storeReference",
    "orderReference",
  ]);
  const cart = parseCartAggregate(raw.cart);
  const batch = parseOrderBatch(raw.batch);
  if (
    cart.orderType !== "Pickup" ||
    cart.diningSessionReference !== null ||
    cart.brandReference !== parseOrderingReference(raw.brandReference) ||
    cart.storeReference !== parseOrderingReference(raw.storeReference) ||
    batch.orderReference !== parseOrderingReference(raw.orderReference) ||
    batch.sourceCartReference !== cart.cartReference ||
    batch.sourceCartVersion !== cart.aggregateVersion ||
    cart.aggregateVersion >= 2147483647 ||
    batch.submittedAt < cart.updatedAt ||
    cart.items.length === 0 ||
    batch.items.length !== cart.items.length
  )
    throw new CartError("CART_VERSION_CONFLICT");
  const submitted = new Set(batch.items.map((item) => item.cartItemReference));
  if (cart.items.some((item) => !submitted.has(item.cartItemReference)))
    throw new CartError("CART_VERSION_CONFLICT");
  const next = parseCartAggregate({
    ...cart,
    aggregateVersion: cart.aggregateVersion + 1,
    updatedAt: batch.submittedAt,
    lifecycle: advanceCartLifecycle(cart.lifecycle, batch.submittedAt),
    items: [],
  });
  return Object.freeze({
    cart: next,
    submissionReference: batch.submissionReference,
    orderBatchReference: batch.orderBatchReference,
    previousCartVersion: cart.aggregateVersion,
    clearedItemReferences: Object.freeze(cart.items.map((item) => item.cartItemReference)),
  });
}
