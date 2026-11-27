import { readClosedRecord } from "@bop/identity";
import { CartError, parseCartAggregate, parseOrderingReference } from "./cart.js";
import { advanceCartLifecycle } from "./cart-lifecycle.js";
import { parseOrderBatch } from "./order.js";

/** Pure transition after exact successful submission. Persist with the Batch in
 * one owner transaction, with current Dining Host/Cart/Checkout fences. Calling
 * this function proves neither that a Batch was persisted nor current authority.
 * It never edits submitted OrderItem transaction snapshots.
 */
export function clearSubmittedDiningCart(value: unknown) {
  const raw = readClosedRecord(value, [
    "cart",
    "batch",
    "brandReference",
    "storeReference",
    "diningSessionReference",
    "orderReference",
  ]);
  const cart = parseCartAggregate(raw.cart);
  const batch = parseOrderBatch(raw.batch);
  if (
    cart.orderType !== "DineIn" ||
    cart.brandReference !== parseOrderingReference(raw.brandReference) ||
    cart.storeReference !== parseOrderingReference(raw.storeReference) ||
    cart.diningSessionReference !== parseOrderingReference(raw.diningSessionReference) ||
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
