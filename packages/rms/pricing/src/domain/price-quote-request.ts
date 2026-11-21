import { parseCanonicalInstant } from "@bop/tenant";
import {
  parsePricingDigest,
  parsePricingReference,
  type PricingDigest,
  type PricingReference,
} from "./money-tax-contract.js";
export interface PriceQuoteRequestIdentity {
  readonly operationReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly guestSessionReference: PricingReference;
  readonly cartReference: PricingReference;
  readonly cartVersion: number;
}
export interface PriceQuoteRequestRecord extends PriceQuoteRequestIdentity {
  readonly recordVersion: 1;
  readonly intentDigest: PricingDigest;
  readonly quoteReference: PricingReference;
  readonly quoteOutcome: "Created" | "Existing";
  readonly createdAt: string;
  readonly idempotencyExpiresAt: string;
}
export class PriceQuoteRequestError extends Error {
  constructor(
    readonly code: "QUOTE_REQUEST_INVALID" | "QUOTE_REQUEST_CONFLICT" | "QUOTE_REQUEST_UNAVAILABLE",
  ) {
    super("price quote request is unavailable");
    this.name = "PriceQuoteRequestError";
  }
}
function invalid(): never {
  throw new PriceQuoteRequestError("QUOTE_REQUEST_INVALID");
}
const identityFields = [
  "operationReference",
  "brandReference",
  "storeReference",
  "guestSessionReference",
  "cartReference",
  "cartVersion",
] as const;
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    invalid();
  return Object.fromEntries(
    fields.map((key) => {
      const d = descriptors[key];
      if (d === undefined || !("value" in d) || !d.enumerable) invalid();
      return [key, d.value];
    }),
  );
}
export function parsePriceQuoteRequestIdentity(value: unknown): PriceQuoteRequestIdentity {
  try {
    const raw = closed(value, identityFields);
    if (
      !Number.isSafeInteger(raw.cartVersion) ||
      (raw.cartVersion as number) < 1 ||
      (raw.cartVersion as number) > 2147483647
    )
      invalid();
    return Object.freeze({
      operationReference: parsePricingReference(raw.operationReference),
      brandReference: parsePricingReference(raw.brandReference),
      storeReference: parsePricingReference(raw.storeReference),
      guestSessionReference: parsePricingReference(raw.guestSessionReference),
      cartReference: parsePricingReference(raw.cartReference),
      cartVersion: raw.cartVersion as number,
    });
  } catch {
    return invalid();
  }
}
export function priceQuoteRequestIntent(value: unknown): string {
  return `PriceQuoteRequest.v1:${JSON.stringify(parsePriceQuoteRequestIdentity(value))}`;
}
export function parsePriceQuoteRequestRecord(value: unknown): PriceQuoteRequestRecord {
  try {
    const raw = closed(value, [
      ...identityFields,
      "recordVersion",
      "intentDigest",
      "quoteReference",
      "quoteOutcome",
      "createdAt",
      "idempotencyExpiresAt",
    ]);
    const identity = parsePriceQuoteRequestIdentity(
      Object.fromEntries(identityFields.map((key) => [key, raw[key]])),
    );
    const createdAt = parseCanonicalInstant(raw.createdAt);
    const idempotencyExpiresAt = parseCanonicalInstant(raw.idempotencyExpiresAt);
    if (
      raw.recordVersion !== 1 ||
      !["Created", "Existing"].includes(raw.quoteOutcome as string) ||
      Date.parse(idempotencyExpiresAt) !== Date.parse(createdAt) + 24 * 60 * 60 * 1000
    )
      invalid();
    return Object.freeze({
      ...identity,
      recordVersion: 1,
      intentDigest: parsePricingDigest(raw.intentDigest),
      quoteReference: parsePricingReference(raw.quoteReference),
      quoteOutcome: raw.quoteOutcome as "Created" | "Existing",
      createdAt,
      idempotencyExpiresAt,
    });
  } catch {
    return invalid();
  }
}
export function assertPriceQuoteRequestReplay(
  record: PriceQuoteRequestRecord,
  identity: PriceQuoteRequestIdentity,
  observedAt: string,
): void {
  const prior = parsePriceQuoteRequestRecord(record);
  const intent = parsePriceQuoteRequestIdentity(identity);
  let at: string;
  try {
    at = parseCanonicalInstant(observedAt);
  } catch {
    return invalid();
  }
  if (
    identityFields.some((key) => prior[key] !== intent[key]) ||
    at < prior.createdAt ||
    at >= prior.idempotencyExpiresAt
  )
    throw new PriceQuoteRequestError("QUOTE_REQUEST_CONFLICT");
}
