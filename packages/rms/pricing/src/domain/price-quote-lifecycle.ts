import { createMoney, type Money } from "./money-tax-contract.js";
import {
  createPriceQuote,
  type CreatePriceQuoteInput,
  type PriceQuoteSnapshot,
} from "./price-quote.js";

export type PriceQuoteValidity = "Current" | "Expired";
export type PriceQuoteChange = "Unchanged" | "Decreased" | "ReconfirmationRequired";

export interface RequotePriceQuoteInput {
  readonly previousQuote: PriceQuoteSnapshot;
  readonly replacementInput: CreatePriceQuoteInput;
  readonly evaluatedAt: string;
}

export interface PriceQuoteRequoteResult {
  readonly previousQuoteReference: PriceQuoteSnapshot["quoteReference"];
  readonly replacementQuote: PriceQuoteSnapshot;
  readonly change: PriceQuoteChange;
  readonly totalChange: Money;
  readonly requiresReconfirmation: boolean;
  readonly evaluatedAt: string;
}

export const priceQuoteLifecycleErrorCodes = [
  "QUOTE_LIFECYCLE_INPUT_INVALID",
  "QUOTE_NOT_EXPIRED",
  "QUOTE_REQUOTE_SCOPE_MISMATCH",
  "QUOTE_REQUOTE_REFERENCE_REUSED",
] as const;
export type PriceQuoteLifecycleErrorCode = (typeof priceQuoteLifecycleErrorCodes)[number];

export class PriceQuoteLifecycleError extends Error {
  readonly code: PriceQuoteLifecycleErrorCode;
  constructor(code: PriceQuoteLifecycleErrorCode) {
    super("price quote lifecycle operation rejected");
    this.name = "PriceQuoteLifecycleError";
    this.code = code;
  }
}

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (code: PriceQuoteLifecycleErrorCode): never => {
  throw new PriceQuoteLifecycleError(code);
};

function at(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    fail("QUOTE_LIFECYCLE_INPUT_INVALID");
  return value as string;
}

export function evaluatePriceQuoteValidity(
  quote: Pick<PriceQuoteSnapshot, "createdAt" | "expiresAt">,
  evaluatedAt: string,
): PriceQuoteValidity {
  const now = Date.parse(at(evaluatedAt));
  const created = Date.parse(at(quote.createdAt));
  const expires = Date.parse(at(quote.expiresAt));
  if (expires <= created || now < created) fail("QUOTE_LIFECYCLE_INPUT_INVALID");
  return now < expires ? "Current" : "Expired";
}

export function requoteExpiredPriceQuote(input: RequotePriceQuoteInput): PriceQuoteRequoteResult {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== 3 ||
    !Reflect.ownKeys(input).every((key) =>
      ["previousQuote", "replacementInput", "evaluatedAt"].includes(String(key)),
    )
  )
    fail("QUOTE_LIFECYCLE_INPUT_INVALID");
  const evaluatedAt = at(input.evaluatedAt);
  if (evaluatePriceQuoteValidity(input.previousQuote, evaluatedAt) !== "Expired")
    fail("QUOTE_NOT_EXPIRED");
  const replacement = input.replacementInput;
  if (
    replacement.createdAt !== evaluatedAt ||
    replacement.brandReference !== input.previousQuote.brandReference ||
    replacement.storeReference !== input.previousQuote.storeReference ||
    replacement.cartReference !== input.previousQuote.cartReference ||
    replacement.cartVersion !== input.previousQuote.cartVersion
  )
    fail("QUOTE_REQUOTE_SCOPE_MISMATCH");
  if (replacement.quoteReference === input.previousQuote.quoteReference)
    fail("QUOTE_REQUOTE_REFERENCE_REUSED");
  const replacementQuote = createPriceQuote(replacement);
  if (
    replacementQuote.currencyMetadata.currencyCode !==
    input.previousQuote.currencyMetadata.currencyCode
  )
    fail("QUOTE_REQUOTE_SCOPE_MISMATCH");
  const changeMinor = replacementQuote.total.amountMinor - input.previousQuote.total.amountMinor;
  const change: PriceQuoteChange =
    changeMinor > 0n ? "ReconfirmationRequired" : changeMinor < 0n ? "Decreased" : "Unchanged";
  return Object.freeze({
    previousQuoteReference: input.previousQuote.quoteReference,
    replacementQuote,
    change,
    totalChange: createMoney({
      amountMinor: changeMinor,
      currencyCode: replacementQuote.currencyMetadata.currencyCode,
    }),
    requiresReconfirmation: change === "ReconfirmationRequired",
    evaluatedAt,
  });
}
