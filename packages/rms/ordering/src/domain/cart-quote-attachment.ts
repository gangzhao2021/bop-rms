import {
  CartError,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";

export interface CartQuoteMoney {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
}

export interface CartQuoteLineEvidence {
  readonly lineReference: OrderingReference;
  readonly sellableReference: OrderingReference;
  readonly productVersionReference: OrderingReference;
  readonly menuVersionReference: OrderingReference;
  readonly quantity: number;
}

export interface CartQuoteAttachment {
  readonly operationReference: OrderingReference;
  readonly operationIntentHash: OrderingHash;
  readonly guestSessionReference: OrderingReference;
  readonly cartReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly cartVersion: number;
  readonly quoteReference: OrderingReference;
  readonly quoteVersion: 1;
  readonly quoteInputDigest: OrderingHash;
  readonly currencyCode: string;
  readonly currencyMetadataVersion: number;
  readonly currencyMetadataVersionReference: OrderingReference;
  readonly subtotal: CartQuoteMoney;
  readonly discount: CartQuoteMoney;
  readonly tax: CartQuoteMoney;
  readonly fee: CartQuoteMoney;
  readonly total: CartQuoteMoney;
  readonly lines: readonly CartQuoteLineEvidence[];
  readonly warnings: readonly string[];
  readonly quoteCreatedAt: OrderingInstant;
  readonly quoteExpiresAt: OrderingInstant;
  readonly attachedAt: OrderingInstant;
  readonly idempotencyExpiresAt: OrderingInstant;
}

const currencyPattern = /^[A-Z]{3}$/u;
const warningPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const minimumMinor = -(2n ** 63n);
const maximumMinor = 2n ** 63n - 1n;

function invalid(): never {
  throw new CartError("CART_QUOTE_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
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
    if (error instanceof CartError) throw error;
    return invalid();
  }
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function currency(value: unknown): string {
  if (typeof value !== "string" || !currencyPattern.test(value)) return invalid();
  return value;
}

function money(value: unknown, expectedCurrency?: string): CartQuoteMoney {
  const raw = exact(value, ["amountMinor", "currencyCode"]);
  if (
    typeof raw.amountMinor !== "bigint" ||
    raw.amountMinor < minimumMinor ||
    raw.amountMinor > maximumMinor
  )
    return invalid();
  const currencyCode = currency(raw.currencyCode);
  if (expectedCurrency !== undefined && currencyCode !== expectedCurrency) return invalid();
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode });
}

function line(value: unknown): CartQuoteLineEvidence {
  const raw = exact(value, [
    "lineReference",
    "sellableReference",
    "productVersionReference",
    "menuVersionReference",
    "quantity",
  ]);
  const quantity = positive(raw.quantity);
  if (quantity > 999) return invalid();
  return Object.freeze({
    lineReference: parseOrderingReference(raw.lineReference),
    sellableReference: parseOrderingReference(raw.sellableReference),
    productVersionReference: parseOrderingReference(raw.productVersionReference),
    menuVersionReference: parseOrderingReference(raw.menuVersionReference),
    quantity,
  });
}

function warnings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) return invalid();
  const parsed = value.map((warning) => {
    if (typeof warning !== "string" || !warningPattern.test(warning)) return invalid();
    return warning;
  });
  return Object.freeze(parsed);
}

export function parseCartQuoteAttachment(value: unknown): CartQuoteAttachment {
  const raw = exact(value, [
    "operationReference",
    "operationIntentHash",
    "guestSessionReference",
    "cartReference",
    "brandReference",
    "storeReference",
    "cartVersion",
    "quoteReference",
    "quoteVersion",
    "quoteInputDigest",
    "currencyCode",
    "currencyMetadataVersion",
    "currencyMetadataVersionReference",
    "subtotal",
    "discount",
    "tax",
    "fee",
    "total",
    "lines",
    "warnings",
    "quoteCreatedAt",
    "quoteExpiresAt",
    "attachedAt",
    "idempotencyExpiresAt",
  ]);
  if (raw.quoteVersion !== 1 || !Array.isArray(raw.lines) || raw.lines.length > 100)
    return invalid();
  const currencyCode = currency(raw.currencyCode);
  const parsedLines = raw.lines.map(line);
  if (new Set(parsedLines.map((item) => item.lineReference)).size !== parsedLines.length)
    return invalid();
  const quoteCreatedAt = parseOrderingInstant(raw.quoteCreatedAt);
  const quoteExpiresAt = parseOrderingInstant(raw.quoteExpiresAt);
  const attachedAt = parseOrderingInstant(raw.attachedAt);
  const idempotencyExpiresAt = parseOrderingInstant(raw.idempotencyExpiresAt);
  if (
    Date.parse(quoteExpiresAt) <= Date.parse(quoteCreatedAt) ||
    Date.parse(attachedAt) < Date.parse(quoteCreatedAt) ||
    Date.parse(attachedAt) >= Date.parse(quoteExpiresAt) ||
    Date.parse(idempotencyExpiresAt) !== Date.parse(attachedAt) + 24 * 60 * 60 * 1_000
  )
    return invalid();
  const subtotal = money(raw.subtotal, currencyCode);
  const discount = money(raw.discount, currencyCode);
  const tax = money(raw.tax, currencyCode);
  const fee = money(raw.fee, currencyCode);
  const total = money(raw.total, currencyCode);
  if (
    [subtotal, discount, tax, fee, total].some((amount) => amount.amountMinor < 0n) ||
    subtotal.amountMinor - discount.amountMinor + tax.amountMinor + fee.amountMinor !==
      total.amountMinor
  )
    return invalid();
  return Object.freeze({
    operationReference: parseOrderingReference(raw.operationReference),
    operationIntentHash: parseOrderingHash(raw.operationIntentHash),
    guestSessionReference: parseOrderingReference(raw.guestSessionReference),
    cartReference: parseOrderingReference(raw.cartReference),
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
    cartVersion: positive(raw.cartVersion),
    quoteReference: parseOrderingReference(raw.quoteReference),
    quoteVersion: 1,
    quoteInputDigest: parseOrderingHash(raw.quoteInputDigest),
    currencyCode,
    currencyMetadataVersion: positive(raw.currencyMetadataVersion),
    currencyMetadataVersionReference: parseOrderingReference(raw.currencyMetadataVersionReference),
    subtotal,
    discount,
    tax,
    fee,
    total,
    lines: Object.freeze(parsedLines),
    warnings: warnings(raw.warnings),
    quoteCreatedAt,
    quoteExpiresAt,
    attachedAt,
    idempotencyExpiresAt,
  });
}
