import {
  parseCartAggregate,
  parseOrderingReference,
  parseOrderingInstant,
  isGuestCartChannel,
} from "../domain/cart.js";
import { parseCartQuoteAttachmentOfVersion } from "../domain/cart-quote-attachment.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import { CheckoutValidationError } from "../domain/checkout-validation.js";
import {
  parseConfiguredOrderCreationRecord,
  parseOrderCreationRecord,
} from "../domain/order-creation.js";
function fail(): never {
  throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return fail();
  return Object.fromEntries(
    fields.map((k) => {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (!d?.enumerable || !("value" in d)) return fail();
      return [k, d.value];
    }),
  );
}
/** Owner source guard only. Caller still needs current Identity, Catalog and final Inventory checks. */
function resolveVersionedPickupCapacityCartSource(value: unknown, quoteVersion: 1 | 2) {
  try {
    const raw = closed(value, [
      "cart",
      "quote",
      "guestSessionReference",
      "brandReference",
      "storeReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "observedAt",
    ]);
    const cart = parseCartAggregate(raw.cart),
      quote = parseCartQuoteAttachmentOfVersion(raw.quote, quoteVersion);
    const guest = parseOrderingReference(raw.guestSessionReference),
      brand = parseOrderingReference(raw.brandReference),
      store = parseOrderingReference(raw.storeReference),
      cartReference = parseOrderingReference(raw.cartReference),
      quoteReference = parseOrderingReference(raw.quoteReference),
      at = parseOrderingInstant(raw.observedAt);
    const lifecycle = assertCartLifecycleActive(cart.lifecycle, at);
    if (
      !Number.isSafeInteger(raw.cartVersion) ||
      (raw.cartVersion as number) < 1 ||
      cart.cartReference !== cartReference ||
      cart.aggregateVersion !== raw.cartVersion ||
      cart.brandReference !== brand ||
      cart.storeReference !== store ||
      cart.createdByActorReference !== guest ||
      cart.orderType !== "Pickup" ||
      cart.diningSessionReference !== null ||
      !isGuestCartChannel(cart.orderType, cart.sourceChannel) ||
      cart.items.length === 0 ||
      cart.updatedAt > at ||
      quote.brandReference !== brand ||
      quote.storeReference !== store ||
      quote.guestSessionReference !== guest ||
      quote.cartReference !== cartReference ||
      quote.cartVersion !== cart.aggregateVersion ||
      quote.quoteReference !== quoteReference ||
      quote.lines.length !== cart.items.length ||
      quote.quoteCreatedAt > at ||
      quote.attachedAt > at ||
      quote.quoteExpiresAt <= at
    )
      return fail();
    const lines = new Map(quote.lines.map((line) => [line.lineReference, line]));
    if (
      lines.size !== cart.items.length ||
      cart.items.some((item) => {
        const line = lines.get(item.cartItemReference);
        return (
          line === undefined ||
          line.sellableReference !== item.sellableReference ||
          line.quantity !== item.quantity ||
          line.menuVersionReference !== item.catalogSelectionEvidence?.menuVersionReference ||
          line.productVersionReference !== item.catalogSelectionEvidence?.productVersionReference
        );
      })
    )
      return fail();
    return Object.freeze({
      brandReference: brand,
      storeReference: store,
      guestSessionReference: guest,
      cartReference,
      cartVersion: cart.aggregateVersion,
      quoteReference,
      quoteInputDigest: quote.quoteInputDigest,
      quoteAttachmentReference: quote.operationReference,
      observedAt: at,
      validUntil: parseOrderingInstant(
        new Date(
          Math.min(
            Date.parse(lifecycle.idleExpiresAt),
            Date.parse(lifecycle.absoluteExpiresAt),
            Date.parse(quote.quoteExpiresAt),
          ),
        ).toISOString(),
      ),
    });
  } catch {
    return fail();
  }
}

export function resolvePickupCapacityCartSource(value: unknown) {
  return resolveVersionedPickupCapacityCartSource(value, 1);
}
export function resolveConfiguredPickupCapacityCartSource(value: unknown) {
  return resolveVersionedPickupCapacityCartSource(value, 2);
}

/**
 * WP-2423 M03: owner source guard once the Order exists. Ordering empties a pickup Cart and moves it
 * to its next version in the Order's own transaction, so the payment clock (and any retry of it)
 * reads the Ordering/Clock facts from the recorded submission: its Cart version, the Quote attached
 * at that version and the ordered lines, never from the Cart as it is now. The Cart must still be
 * this guest's pickup Cart and must have moved past the ordered version. The resulting units
 * digest is the one prepared before the Order, so an unchanged commitment matches exactly.
 */
function resolveVersionedOrderedPickupCapacityCartSource(value: unknown, quoteVersion: 1 | 2) {
  try {
    const raw = closed(value, [
      "cart",
      "quote",
      "order",
      "guestSessionReference",
      "brandReference",
      "storeReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "submissionReference",
      "observedAt",
    ]);
    const cart = parseCartAggregate(raw.cart),
      quote = parseCartQuoteAttachmentOfVersion(raw.quote, quoteVersion),
      record =
        quoteVersion === 2
          ? parseConfiguredOrderCreationRecord(raw.order)
          : parseOrderCreationRecord(raw.order);
    const guest = parseOrderingReference(raw.guestSessionReference),
      brand = parseOrderingReference(raw.brandReference),
      store = parseOrderingReference(raw.storeReference),
      cartReference = parseOrderingReference(raw.cartReference),
      quoteReference = parseOrderingReference(raw.quoteReference),
      submissionReference = parseOrderingReference(raw.submissionReference),
      at = parseOrderingInstant(raw.observedAt);
    const lifecycle = assertCartLifecycleActive(cart.lifecycle, at);
    const order = record.order,
      batch = order.batches[0];
    if (
      !Number.isSafeInteger(raw.cartVersion) ||
      (raw.cartVersion as number) < 1 ||
      batch === undefined ||
      order.batches.length !== 1 ||
      cart.cartReference !== cartReference ||
      cart.aggregateVersion <= (raw.cartVersion as number) ||
      cart.brandReference !== brand ||
      cart.storeReference !== store ||
      cart.createdByActorReference !== guest ||
      cart.orderType !== "Pickup" ||
      cart.diningSessionReference !== null ||
      !isGuestCartChannel(cart.orderType, cart.sourceChannel) ||
      cart.updatedAt > at ||
      record.submissionReference !== submissionReference ||
      record.guestSessionReference !== guest ||
      order.brandReference !== brand ||
      order.storeReference !== store ||
      order.orderType !== "Pickup" ||
      order.diningSessionReference !== null ||
      batch.sourceCartReference !== cartReference ||
      batch.sourceCartVersion !== raw.cartVersion ||
      batch.quoteReference !== quoteReference ||
      record.createdAt > at ||
      quote.brandReference !== brand ||
      quote.storeReference !== store ||
      quote.guestSessionReference !== guest ||
      quote.cartReference !== cartReference ||
      quote.cartVersion !== raw.cartVersion ||
      quote.quoteReference !== quoteReference ||
      quote.lines.length !== record.items.length ||
      quote.quoteCreatedAt > at ||
      quote.attachedAt > at ||
      quote.quoteExpiresAt <= at
    )
      return fail();
    const lines = new Map(quote.lines.map((line) => [line.lineReference, line]));
    if (
      lines.size !== record.items.length ||
      record.items.some((item) => {
        const line = lines.get(item.cartItemReference);
        return line === undefined || line.quantity !== item.quantity;
      })
    )
      return fail();
    return Object.freeze({
      brandReference: brand,
      storeReference: store,
      guestSessionReference: guest,
      cartReference,
      cartVersion: batch.sourceCartVersion,
      quoteReference,
      quoteInputDigest: quote.quoteInputDigest,
      quoteAttachmentReference: quote.operationReference,
      observedAt: at,
      validUntil: parseOrderingInstant(
        new Date(
          Math.min(
            Date.parse(lifecycle.idleExpiresAt),
            Date.parse(lifecycle.absoluteExpiresAt),
            Date.parse(quote.quoteExpiresAt),
          ),
        ).toISOString(),
      ),
    });
  } catch {
    return fail();
  }
}
export function resolveOrderedPickupCapacityCartSource(value: unknown) {
  return resolveVersionedOrderedPickupCapacityCartSource(value, 1);
}
export function resolveConfiguredOrderedPickupCapacityCartSource(value: unknown) {
  return resolveVersionedOrderedPickupCapacityCartSource(value, 2);
}
