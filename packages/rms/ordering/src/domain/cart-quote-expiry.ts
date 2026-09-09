import {
  CartError,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
} from "./cart.js";

const references = [
  "operationReference",
  "brandReference",
  "storeReference",
  "cartReference",
  "guestSessionReference",
  "quoteReference",
] as const;
const hashes = ["quoteInputDigest", "requestIntentDigest"] as const;
const times = [
  "quoteCreatedAt",
  "quoteExpiresAt",
  "requestCreatedAt",
  "requestExpiresAt",
  "expiredAt",
] as const;
export type CartQuoteExpiryRecord = Readonly<
  { resolutionVersion: 1; cartVersion: number } & Record<
    (typeof references)[number],
    ReturnType<typeof parseOrderingReference>
  > &
    Record<(typeof hashes)[number], ReturnType<typeof parseOrderingHash>> &
    Record<(typeof times)[number], ReturnType<typeof parseOrderingInstant>>
>;

export function parseCartQuoteExpiryRecord(value: unknown): CartQuoteExpiryRecord {
  const invalid = (): never => {
    throw new CartError("CART_QUOTE_INVALID");
  };
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const fields = ["resolutionVersion", "cartVersion", ...references, ...hashes, ...times];
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const raw: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        return invalid();
      raw[field] = descriptor.value;
    }
    if (
      raw.resolutionVersion !== 1 ||
      typeof raw.cartVersion !== "number" ||
      !Number.isInteger(raw.cartVersion) ||
      raw.cartVersion < 1 ||
      raw.cartVersion > 2147483647
    )
      return invalid();
    const result: Record<string, unknown> = { resolutionVersion: 1, cartVersion: raw.cartVersion };
    for (const field of references) result[field] = parseOrderingReference(raw[field]);
    for (const field of hashes) result[field] = parseOrderingHash(raw[field]);
    for (const field of times) result[field] = parseOrderingInstant(raw[field]);
    const parsed = result as CartQuoteExpiryRecord;
    if (
      parsed.quoteCreatedAt > parsed.requestCreatedAt ||
      parsed.requestCreatedAt >= parsed.quoteExpiresAt ||
      parsed.expiredAt < parsed.quoteExpiresAt ||
      Date.parse(parsed.requestExpiresAt) - Date.parse(parsed.requestCreatedAt) !== 86400000
    )
      return invalid();
    return Object.freeze(parsed);
  } catch {
    return invalid();
  }
}

export function sameCartQuoteExpiryIntent(
  a: CartQuoteExpiryRecord,
  b: CartQuoteExpiryRecord,
): boolean {
  return (Object.keys(a) as (keyof CartQuoteExpiryRecord)[]).every(
    (key) => key === "expiredAt" || a[key] === b[key],
  );
}
