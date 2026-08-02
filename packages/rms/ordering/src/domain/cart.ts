export type OrderingReference = string & { readonly __orderingReference: unique symbol };
export type OrderingInstant = string & { readonly __orderingInstant: unique symbol };
export type CartOrderType = "DineIn" | "Pickup";
export type CartSourceChannel = "Api" | "Pos" | "Qr" | "Web";

export interface CartOptionSelection {
  readonly optionReference: OrderingReference;
  readonly quantity: number;
}

export interface CartItem {
  readonly cartItemReference: OrderingReference;
  readonly cartReference: OrderingReference;
  readonly sellableReference: OrderingReference;
  readonly quantity: number;
  readonly optionSelections: readonly CartOptionSelection[];
  readonly addedByActorReference: OrderingReference;
  readonly addedByParticipantReference: OrderingReference | null;
  readonly addedAt: OrderingInstant;
}

export interface CartAggregate {
  readonly cartReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderType: CartOrderType;
  readonly sourceChannel: CartSourceChannel;
  readonly diningSessionReference: OrderingReference | null;
  readonly createdByActorReference: OrderingReference;
  readonly aggregateVersion: number;
  readonly createdAt: OrderingInstant;
  readonly updatedAt: OrderingInstant;
  readonly items: readonly CartItem[];
}

export const cartErrorCodes = ["CART_INPUT_INVALID"] as const;
export type CartErrorCode = (typeof cartErrorCodes)[number];

export class CartError extends Error {
  readonly code: CartErrorCode;

  constructor(code: CartErrorCode) {
    super("cart input is invalid");
    this.name = "CartError";
    this.code = code;
  }
}

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function invalid(): never {
  throw new CartError("CART_INPUT_INVALID");
}

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const parsed: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return invalid();
      parsed[key] = descriptor.value;
    }
    return Object.freeze(parsed);
  } catch (error) {
    if (error instanceof CartError) throw error;
    return invalid();
  }
}

export function parseOrderingReference(value: unknown): OrderingReference {
  if (typeof value !== "string" || !uuidV7Pattern.test(value)) return invalid();
  return value as OrderingReference;
}

export function parseOrderingInstant(value: unknown): OrderingInstant {
  if (typeof value !== "string" || !instantPattern.test(value)) return invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    return invalid();
  return value as OrderingInstant;
}

function quantity(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 999)
    return invalid();
  return value as number;
}

export function parseCartOptionSelection(value: unknown): CartOptionSelection {
  const raw = closed(value, ["optionReference", "quantity"]);
  return Object.freeze({
    optionReference: parseOrderingReference(raw.optionReference),
    quantity: quantity(raw.quantity),
  });
}

export function parseCartItem(value: unknown): CartItem {
  const raw = closed(value, [
    "cartItemReference",
    "cartReference",
    "sellableReference",
    "quantity",
    "optionSelections",
    "addedByActorReference",
    "addedByParticipantReference",
    "addedAt",
  ]);
  if (!Array.isArray(raw.optionSelections) || raw.optionSelections.length > 100) return invalid();
  const optionSelections = raw.optionSelections.map(parseCartOptionSelection);
  if (
    new Set(optionSelections.map((selection) => selection.optionReference)).size !==
    optionSelections.length
  )
    return invalid();
  return Object.freeze({
    cartItemReference: parseOrderingReference(raw.cartItemReference),
    cartReference: parseOrderingReference(raw.cartReference),
    sellableReference: parseOrderingReference(raw.sellableReference),
    quantity: quantity(raw.quantity),
    optionSelections: Object.freeze(optionSelections),
    addedByActorReference: parseOrderingReference(raw.addedByActorReference),
    addedByParticipantReference:
      raw.addedByParticipantReference === null
        ? null
        : parseOrderingReference(raw.addedByParticipantReference),
    addedAt: parseOrderingInstant(raw.addedAt),
  });
}

export function parseCartAggregate(value: unknown): CartAggregate {
  const raw = closed(value, [
    "cartReference",
    "brandReference",
    "storeReference",
    "orderType",
    "sourceChannel",
    "diningSessionReference",
    "createdByActorReference",
    "aggregateVersion",
    "createdAt",
    "updatedAt",
    "items",
  ]);
  if (raw.orderType !== "DineIn" && raw.orderType !== "Pickup") return invalid();
  if (!["Api", "Pos", "Qr", "Web"].includes(raw.sourceChannel as string)) return invalid();
  if (!Array.isArray(raw.items) || raw.items.length > 100) return invalid();
  const cartReference = parseOrderingReference(raw.cartReference);
  const createdAt = parseOrderingInstant(raw.createdAt);
  const updatedAt = parseOrderingInstant(raw.updatedAt);
  const diningSessionReference =
    raw.diningSessionReference === null ? null : parseOrderingReference(raw.diningSessionReference);
  if (
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (raw.orderType === "DineIn") !== (diningSessionReference !== null)
  )
    return invalid();
  const items = raw.items.map(parseCartItem);
  if (
    items.some(
      (item) =>
        item.cartReference !== cartReference ||
        (raw.orderType === "DineIn" && item.addedByParticipantReference === null),
    ) ||
    new Set(items.map((item) => item.cartItemReference)).size !== items.length
  )
    return invalid();
  return Object.freeze({
    cartReference,
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
    orderType: raw.orderType,
    sourceChannel: raw.sourceChannel as CartSourceChannel,
    diningSessionReference,
    createdByActorReference: parseOrderingReference(raw.createdByActorReference),
    aggregateVersion: quantity(raw.aggregateVersion),
    createdAt,
    updatedAt,
    items: Object.freeze(items),
  });
}
