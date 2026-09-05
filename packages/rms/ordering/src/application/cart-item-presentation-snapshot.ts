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
