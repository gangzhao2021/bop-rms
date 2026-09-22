import {
  parseCartAggregate,
  parseOrderingReference,
  parseOrderingInstant,
} from "../domain/cart.js";
import {
  parseCartQuoteAttachment,
  parseConfiguredCartQuoteAttachment,
} from "../domain/cart-quote-attachment.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import { CheckoutValidationError } from "../domain/checkout-validation.js";
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
      quote =
        quoteVersion === 2
          ? parseConfiguredCartQuoteAttachment(raw.quote)
          : parseCartQuoteAttachment(raw.quote);
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
      !["Qr", "Web"].includes(cart.sourceChannel) ||
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
