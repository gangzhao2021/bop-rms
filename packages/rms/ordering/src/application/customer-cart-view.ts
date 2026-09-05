import { CartError, parseCartAggregate, parseOrderingInstant } from "../domain/cart.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import type { CustomerCartView } from "../contracts/customer-cart-view.js";

export interface CustomerCartDisplayRequest {
  readonly purpose: "CustomerCart";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly publicStoreReference: string;
  readonly locale: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly evaluatedAt: string;
}

function closed(value: unknown, keys: readonly string[]) {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length)
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  const parsed: Record<string, unknown> = {};
  for (const key of keys) {
    const field = descriptors[key];
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable)
      throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
    parsed[key] = field.value;
  }
  return parsed;
}
function label(value: unknown) {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > 200 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  return value.normalize("NFC").trim();
}
export function parseCustomerCartDisplay(value: unknown, request: CustomerCartDisplayRequest) {
  const raw = closed(value, [
    "purpose",
    "brandReference",
    "storeReference",
    "publicStoreReference",
    "locale",
    "orderType",
    "evaluatedAt",
    "brandName",
    "storeName",
    "serviceMode",
  ]);
  for (const key of [
    "purpose",
    "brandReference",
    "storeReference",
    "publicStoreReference",
    "locale",
    "orderType",
    "evaluatedAt",
  ] as const) {
    if (raw[key] !== request[key]) throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
  if (request.purpose !== "CustomerCart" || raw.serviceMode !== request.orderType)
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  parseOrderingInstant(request.evaluatedAt);
  return Object.freeze({
    ...request,
    brandName: label(raw.brandName),
    storeName: label(raw.storeName),
    serviceMode: request.orderType,
  });
}

export function createEmptyCustomerCartView(
  value: unknown,
  display: ReturnType<typeof parseCustomerCartDisplay>,
): CustomerCartView {
  display = parseCustomerCartDisplay(display, display);
  const cart = parseCartAggregate(value);
  if (
    cart.brandReference !== display.brandReference ||
    cart.storeReference !== display.storeReference ||
    cart.orderType !== display.orderType ||
    cart.aggregateVersion !== 1 ||
    cart.items.length !== 0 ||
    cart.createdAt !== cart.updatedAt
  )
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  const lifecycle = assertCartLifecycleActive(cart.lifecycle, cart.updatedAt);
  return Object.freeze({
    schemaVersion: 1,
    cart: Object.freeze({
      cartReference: cart.cartReference,
      version: cart.aggregateVersion,
      orderType: cart.orderType,
      serviceMode: display.serviceMode,
      context: Object.freeze({ brandName: display.brandName, storeName: display.storeName }),
      lifecycle: Object.freeze({
        status: lifecycle.status,
        idleExpiresAt: lifecycle.idleExpiresAt,
        absoluteExpiresAt: lifecycle.absoluteExpiresAt,
      }),
      items: Object.freeze([]),
      quote: null,
      warnings: Object.freeze([]),
    }),
  });
}
