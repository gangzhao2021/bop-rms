import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartOrderType,
  type CartSourceChannel,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";

export type CheckoutFulfillmentRejectionReason =
  "STORE_CLOSED" | "CAPACITY_UNAVAILABLE" | "FULFILLMENT_UNAVAILABLE";

export interface CheckoutFulfillmentAccepted {
  readonly status: "Accepted";
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly cartReference: OrderingReference;
  readonly cartVersion: number;
  readonly quoteReference: OrderingReference;
  readonly orderType: CartOrderType;
  readonly sourceChannel: CartSourceChannel;
  readonly evidenceReference: OrderingReference;
  readonly evidenceVersion: number;
  readonly evidenceDigest: OrderingHash;
  readonly checkedAt: OrderingInstant;
  readonly validUntil: OrderingInstant;
}

export type CheckoutFulfillmentValidationResult =
  | CheckoutFulfillmentAccepted
  | {
      readonly status: "Rejected";
      readonly reason: CheckoutFulfillmentRejectionReason;
    };

export interface CheckoutCatalogLineEvidence {
  readonly cartItemReference: OrderingReference;
  readonly sellableReference: OrderingReference;
  readonly menuVersionReference: OrderingReference;
  readonly productVersionReference: OrderingReference;
  readonly validatedAt: OrderingInstant;
}

export interface CheckoutValidationEvidence<V extends 1 | 2 = 1> {
  readonly validationReference: OrderingReference;
  readonly validationIntentHash: OrderingHash;
  readonly guestSessionReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly cartReference: OrderingReference;
  readonly cartVersion: number;
  readonly quoteReference: OrderingReference;
  readonly quoteVersion: V;
  readonly quoteInputDigest: OrderingHash;
  readonly orderType: CartOrderType;
  readonly sourceChannel: CartSourceChannel;
  readonly catalogLines: readonly CheckoutCatalogLineEvidence[];
  readonly fulfillment: CheckoutFulfillmentAccepted;
  readonly validatedAt: OrderingInstant;
  readonly validUntil: OrderingInstant;
}

export const checkoutValidationErrorCodes = [
  "CHECKOUT_INPUT_INVALID",
  "CHECKOUT_PERMISSION_DENIED",
  "CHECKOUT_CART_UNAVAILABLE",
  "CHECKOUT_CART_VERSION_CONFLICT",
  "CHECKOUT_CART_EMPTY",
  "CHECKOUT_CART_NOT_ACTIVE",
  "CHECKOUT_QUOTE_MISSING",
  "CHECKOUT_QUOTE_EXPIRED",
  "CHECKOUT_REQUOTE_REQUIRED",
  "CHECKOUT_ITEM_UNAVAILABLE",
  "CHECKOUT_SELECTION_INVALID",
  "CHECKOUT_STORE_CLOSED",
  "CHECKOUT_CAPACITY_UNAVAILABLE",
  "CHECKOUT_FULFILLMENT_UNAVAILABLE",
  /** WP-2423: the Store's stock cannot make this Cart as it stands (see `line`). */
  "CHECKOUT_STOCK_SHORT",
  "CHECKOUT_DEPENDENCY_UNAVAILABLE",
] as const;

export type CheckoutValidationErrorCode = (typeof checkoutValidationErrorCodes)[number];

/**
 * WP-2423: the Cart line a checkout refusal is about, so the guest (or staff member) is told which
 * item to change. `available`: for CHECKOUT_STOCK_SHORT, how many of that item (with its options,
 * all its lines together) the Store's stock covers with the rest of the Cart unchanged (0: none);
 * null for CHECKOUT_ITEM_UNAVAILABLE. `sharedStock`: the item alone could be made in the quantity
 * ordered; it is short only because other items in the Cart use the same stock.
 */
export interface CheckoutLineRefusal {
  readonly cartItemReference: OrderingReference;
  readonly available: number | null;
  readonly sharedStock: boolean;
}

export class CheckoutValidationError extends Error {
  readonly code: CheckoutValidationErrorCode;
  /** For CHECKOUT_STOCK_SHORT (always) and CHECKOUT_ITEM_UNAVAILABLE (when known). */
  readonly line: CheckoutLineRefusal | null;

  constructor(code: CheckoutValidationErrorCode, line: CheckoutLineRefusal | null = null) {
    super("checkout is unavailable");
    this.name = "CheckoutValidationError";
    this.code = code;
    this.line = line === null ? null : Object.freeze({ ...line });
  }
}

function invalid(): never {
  throw new CheckoutValidationError("CHECKOUT_INPUT_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CheckoutValidationError) throw error;
    return invalid();
  }
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function array(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CheckoutValidationError) throw error;
    return invalid();
  }
}

function line(value: unknown): CheckoutCatalogLineEvidence {
  const raw = exact(value, [
    "cartItemReference",
    "sellableReference",
    "menuVersionReference",
    "productVersionReference",
    "validatedAt",
  ]);
  try {
    return Object.freeze({
      cartItemReference: parseOrderingReference(raw.cartItemReference),
      sellableReference: parseOrderingReference(raw.sellableReference),
      menuVersionReference: parseOrderingReference(raw.menuVersionReference),
      productVersionReference: parseOrderingReference(raw.productVersionReference),
      validatedAt: parseOrderingInstant(raw.validatedAt),
    });
  } catch {
    return invalid();
  }
}

function fulfillment(value: unknown): CheckoutFulfillmentAccepted {
  const raw = exact(value, [
    "status",
    "brandReference",
    "storeReference",
    "cartReference",
    "cartVersion",
    "quoteReference",
    "orderType",
    "sourceChannel",
    "evidenceReference",
    "evidenceVersion",
    "evidenceDigest",
    "checkedAt",
    "validUntil",
  ]);
  if (
    raw.status !== "Accepted" ||
    !["DineIn", "Pickup"].includes(String(raw.orderType)) ||
    !["Api", "Pos", "Qr", "Web"].includes(String(raw.sourceChannel))
  )
    return invalid();
  try {
    const checkedAt = parseOrderingInstant(raw.checkedAt);
    const validUntil = parseOrderingInstant(raw.validUntil);
    if (Date.parse(validUntil) <= Date.parse(checkedAt)) return invalid();
    return Object.freeze({
      status: "Accepted",
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      cartReference: parseOrderingReference(raw.cartReference),
      cartVersion: version(raw.cartVersion),
      quoteReference: parseOrderingReference(raw.quoteReference),
      orderType: raw.orderType as CheckoutFulfillmentAccepted["orderType"],
      sourceChannel: raw.sourceChannel as CheckoutFulfillmentAccepted["sourceChannel"],
      evidenceReference: parseOrderingReference(raw.evidenceReference),
      evidenceVersion: version(raw.evidenceVersion),
      evidenceDigest: parseOrderingHash(raw.evidenceDigest),
      checkedAt,
      validUntil,
    });
  } catch (error) {
    if (error instanceof CheckoutValidationError) throw error;
    return invalid();
  }
}

function parseEvidence<V extends 1 | 2>(
  value: unknown,
  quoteVersion: V,
): CheckoutValidationEvidence<V> {
  const raw = exact(value, [
    "validationReference",
    "validationIntentHash",
    "guestSessionReference",
    "brandReference",
    "storeReference",
    "cartReference",
    "cartVersion",
    "quoteReference",
    "quoteVersion",
    "quoteInputDigest",
    "orderType",
    "sourceChannel",
    "catalogLines",
    "fulfillment",
    "validatedAt",
    "validUntil",
  ]);
  if (
    raw.quoteVersion !== quoteVersion ||
    !["DineIn", "Pickup"].includes(String(raw.orderType)) ||
    !["Api", "Pos", "Qr", "Web"].includes(String(raw.sourceChannel)) ||
    !Array.isArray(raw.catalogLines)
  )
    return invalid();
  try {
    const brandReference = parseOrderingReference(raw.brandReference);
    const storeReference = parseOrderingReference(raw.storeReference);
    const cartReference = parseOrderingReference(raw.cartReference);
    const cartVersion = version(raw.cartVersion);
    const quoteReference = parseOrderingReference(raw.quoteReference);
    const validatedAt = parseOrderingInstant(raw.validatedAt);
    const validUntil = parseOrderingInstant(raw.validUntil);
    const catalogLines = Object.freeze(array(raw.catalogLines, 1, 100).map(line));
    const acceptedFulfillment = fulfillment(raw.fulfillment);
    if (
      Date.parse(validUntil) <= Date.parse(validatedAt) ||
      Date.parse(validUntil) > Date.parse(acceptedFulfillment.validUntil) ||
      acceptedFulfillment.brandReference !== brandReference ||
      acceptedFulfillment.storeReference !== storeReference ||
      acceptedFulfillment.cartReference !== cartReference ||
      acceptedFulfillment.cartVersion !== cartVersion ||
      acceptedFulfillment.quoteReference !== quoteReference ||
      acceptedFulfillment.orderType !== raw.orderType ||
      acceptedFulfillment.sourceChannel !== raw.sourceChannel ||
      acceptedFulfillment.checkedAt !== validatedAt ||
      catalogLines.some((candidate) => candidate.validatedAt !== validatedAt) ||
      new Set(catalogLines.map((candidate) => candidate.cartItemReference)).size !==
        catalogLines.length
    )
      return invalid();
    return Object.freeze({
      validationReference: parseOrderingReference(raw.validationReference),
      validationIntentHash: parseOrderingHash(raw.validationIntentHash),
      guestSessionReference: parseOrderingReference(raw.guestSessionReference),
      brandReference,
      storeReference,
      cartReference,
      cartVersion,
      quoteReference,
      quoteVersion,
      quoteInputDigest: parseOrderingHash(raw.quoteInputDigest),
      orderType: raw.orderType as CheckoutValidationEvidence["orderType"],
      sourceChannel: raw.sourceChannel as CheckoutValidationEvidence["sourceChannel"],
      catalogLines,
      fulfillment: acceptedFulfillment,
      validatedAt,
      validUntil,
    });
  } catch (error) {
    if (error instanceof CheckoutValidationError) throw error;
    return invalid();
  }
}

export function parseCheckoutValidationEvidence(value: unknown): CheckoutValidationEvidence {
  return parseEvidence(value, 1);
}
export function parseConfiguredCheckoutValidationEvidence(
  value: unknown,
): CheckoutValidationEvidence<2> {
  return parseEvidence(value, 2);
}
