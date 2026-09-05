import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import type { CustomerCartView } from "../contracts/customer-cart-view.js";
import { CartError, parseCartAggregate, type CartAggregate } from "../domain/cart.js";

/** Immutable public label evidence for an original command result; never a price or Quote claim. */
export interface CartItemPresentationSnapshot {
  readonly schemaVersion: 1;
  readonly brandName: string;
  readonly storeName: string;
  readonly serviceMode: "Pickup";
  readonly items: readonly {
    readonly cartItemReference: string;
    readonly displayName: string;
    readonly configuration: readonly {
      readonly optionReference: string;
      readonly displayName: string;
    }[];
  }[];
}
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function object(value: unknown, keys: readonly string[]) {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return unavailable();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) return unavailable();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = fields[key];
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return unavailable();
    result[key] = field.value;
  }
  return result;
}
function list(value: unknown, length: number) {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    Reflect.ownKeys(value).length !== length + 1
  )
    return unavailable();
  const fields = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length }, (_, index) => {
    const field = fields[String(index)];
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return unavailable();
    return field.value as unknown;
  });
}
function label(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    value !== value.normalize("NFC").trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return unavailable();
  return value;
}
export function parseCartItemPresentationSnapshot(
  value: unknown,
  result: CartAggregate,
): CartItemPresentationSnapshot {
  try {
    const cart = parseCartAggregate(result);
    if (cart.orderType !== "Pickup" || cart.items.length > 100) return unavailable();
    const raw = object(value, ["schemaVersion", "brandName", "storeName", "serviceMode", "items"]);
    if (raw.schemaVersion !== 1 || raw.serviceMode !== cart.orderType) return unavailable();
    return Object.freeze({
      schemaVersion: 1,
      brandName: label(raw.brandName),
      storeName: label(raw.storeName),
      serviceMode: "Pickup",
      items: Object.freeze(
        list(raw.items, cart.items.length).map((value, index) => {
          const item = cart.items[index];
          if (!item || item.quantity > 100 || item.optionSelections.length > 50)
            return unavailable();
          const rawItem = object(value, ["cartItemReference", "displayName", "configuration"]);
          if (rawItem.cartItemReference !== item.cartItemReference) return unavailable();
          return Object.freeze({
            cartItemReference: item.cartItemReference,
            displayName: label(rawItem.displayName),
            configuration: Object.freeze(
              list(rawItem.configuration, item.optionSelections.length).map((value, index) => {
                const option = item.optionSelections[index];
                const rawOption = object(value, ["optionReference", "displayName"]);
                if (
                  !option ||
                  option.quantity > 100 ||
                  rawOption.optionReference !== option.optionReference
                )
                  return unavailable();
                return Object.freeze({
                  optionReference: option.optionReference,
                  displayName: label(rawOption.displayName),
                });
              }),
            ),
          });
        }),
      ),
    });
  } catch {
    return unavailable();
  }
}

/** Reconstruct the original command response only from persisted transaction evidence. */
export function createCartItemResultView(result: {
  aggregate: CartAggregate;
  presentationSnapshot?: CartItemPresentationSnapshot;
  quoteAbsenceVerified?: true;
}): CustomerCartView {
  if (result.quoteAbsenceVerified !== true) return unavailable();
  const cart = parseCartAggregate(result.aggregate);
  const snapshot = parseCartItemPresentationSnapshot(result.presentationSnapshot, cart);
  const lifecycle = assertCartLifecycleActive(cart.lifecycle, cart.updatedAt);
  return Object.freeze({
    schemaVersion: 1,
    cart: Object.freeze({
      cartReference: cart.cartReference,
      version: cart.aggregateVersion,
      orderType: cart.orderType,
      serviceMode: snapshot.serviceMode,
      context: Object.freeze({ brandName: snapshot.brandName, storeName: snapshot.storeName }),
      lifecycle: Object.freeze({
        status: lifecycle.status,
        idleExpiresAt: lifecycle.idleExpiresAt,
        absoluteExpiresAt: lifecycle.absoluteExpiresAt,
      }),
      items: Object.freeze(
        cart.items.map((item, index) => {
          const labels = snapshot.items[index];
          if (!labels) return unavailable();
          return Object.freeze({
            cartItemReference: item.cartItemReference,
            sellableReference: item.sellableReference,
            displayName: labels.displayName,
            quantity: item.quantity,
            customerNote: item.customerNote,
            configuration: Object.freeze(
              item.optionSelections.map((option, index) => {
                const label = labels.configuration[index];
                if (!label) return unavailable();
                return Object.freeze({
                  optionReference: option.optionReference,
                  quantity: option.quantity,
                  displayName: label.displayName,
                });
              }),
            ),
            lineEstimate: Object.freeze({
              status: "Unavailable" as const,
              reasonCode: "PRICE_UNAVAILABLE",
            }),
            warnings: Object.freeze([]),
          });
        }),
      ),
      quote: null,
      warnings: Object.freeze([]),
    }),
  });
}
