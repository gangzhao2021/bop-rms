import {
  createCurrencyMetadataSnapshot,
  createMoney,
  parsePricingDigest,
  parsePricingReference,
  type CurrencyMetadataSnapshot,
  type Money,
  type PricingDigest,
  type PricingReference,
  type TaxCalculationExplanation,
} from "./money-tax-contract.js";
import { addMoney, calculateTax } from "./money-tax.js";
import {
  resolvePrice,
  type PriceBookSnapshot,
  type PriceResolutionContext,
  type ResolvedPrice,
} from "./price-resolution.js";
import {
  resolveTaxConfiguration,
  type TaxConfigurationResolution,
  type TaxConfigurationSnapshot,
  type TaxResolutionContext,
} from "./tax-configuration.js";

export interface PriceQuoteLineRequest {
  readonly lineReference: PricingReference;
  readonly sellableReference: PricingReference;
  readonly productVersionReference: PricingReference;
  readonly menuVersionReference: PricingReference;
  readonly quantity: number;
  readonly priceContext: PriceResolutionContext;
  readonly taxContext: TaxResolutionContext;
}

export interface CreatePriceQuoteInput {
  readonly quoteReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly cartReference: PricingReference;
  readonly cartVersion: number;
  readonly inputDigest: PricingDigest;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly priceBook: PriceBookSnapshot;
  readonly taxConfiguration: TaxConfigurationSnapshot;
  readonly lines: readonly PriceQuoteLineRequest[];
}

export interface PriceQuoteTaxLine {
  readonly taxAmount: Money;
  readonly explanation: TaxCalculationExplanation;
  readonly calculationOrder: number;
  readonly compoundOnPriorTax: boolean;
  readonly ruleReference: PricingReference;
}

export interface PriceQuoteLineSnapshot {
  readonly lineReference: PricingReference;
  readonly sellableReference: PricingReference;
  readonly productVersionReference: PricingReference;
  readonly menuVersionReference: PricingReference;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly subtotal: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly fee: Money;
  readonly total: Money;
  readonly resolvedPrice: ResolvedPrice;
  readonly taxResolution: TaxConfigurationResolution;
  readonly taxLines: readonly PriceQuoteTaxLine[];
}

export interface PriceQuoteSnapshot {
  readonly quoteReference: PricingReference;
  readonly quoteVersion: 1;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly cartReference: PricingReference;
  readonly cartVersion: number;
  readonly inputDigest: PricingDigest;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly subtotal: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly fee: Money;
  readonly total: Money;
  readonly lines: readonly PriceQuoteLineSnapshot[];
  readonly appliedPromotionReferences: readonly PricingReference[];
  readonly warnings: readonly string[];
  readonly blockingReasons: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export const priceQuoteErrorCodes = [
  "QUOTE_INPUT_INVALID",
  "QUOTE_SCOPE_MISMATCH",
  "QUOTE_CURRENCY_MISMATCH",
  "QUOTE_UNSUPPORTED_TAX_MODE",
  "QUOTE_CALCULATION_FAILED",
] as const;
export type PriceQuoteErrorCode = (typeof priceQuoteErrorCodes)[number];

export class PriceQuoteError extends Error {
  readonly code: PriceQuoteErrorCode;
  constructor(code: PriceQuoteErrorCode) {
    super("price quote could not be created");
    this.name = "PriceQuoteError";
    this.code = code;
  }
}

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (code: PriceQuoteErrorCode): never => {
  throw new PriceQuoteError(code);
};

function exact(value: object, fields: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("QUOTE_INPUT_INVALID");
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(fields);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !allowed.has(field)) ||
    keys.some(
      (field) =>
        typeof field !== "string" ||
        !("value" in (descriptors[field] ?? {})) ||
        descriptors[field]?.enumerable !== true,
    )
  )
    fail("QUOTE_INPUT_INVALID");
}

function at(value: unknown): string {
  if (typeof value !== "string" || !instant.test(value) || !Number.isFinite(Date.parse(value)))
    fail("QUOTE_INPUT_INVALID");
  return value as string;
}

function reference(value: unknown): PricingReference {
  try {
    return parsePricingReference(value);
  } catch {
    return fail("QUOTE_INPUT_INVALID");
  }
}

function digest(value: unknown): PricingDigest {
  try {
    return parsePricingDigest(value);
  } catch {
    return fail("QUOTE_INPUT_INVALID");
  }
}

function zero(currencyCode: CurrencyMetadataSnapshot["currencyCode"]): Money {
  return createMoney({ amountMinor: 0n, currencyCode });
}

function multiply(amount: Money, quantity: number): Money {
  try {
    return createMoney({
      amountMinor: amount.amountMinor * BigInt(quantity),
      currencyCode: amount.currencyCode,
    });
  } catch {
    return fail("QUOTE_CALCULATION_FAILED");
  }
}

export function createPriceQuote(input: CreatePriceQuoteInput): PriceQuoteSnapshot {
  exact(input, [
    "quoteReference",
    "brandReference",
    "storeReference",
    "cartReference",
    "cartVersion",
    "inputDigest",
    "createdAt",
    "expiresAt",
    "currencyMetadata",
    "priceBook",
    "taxConfiguration",
    "lines",
  ]);
  const createdAt = at(input.createdAt);
  const expiresAt = at(input.expiresAt);
  if (
    !Number.isSafeInteger(input.cartVersion) ||
    input.cartVersion < 1 ||
    Date.parse(expiresAt) <= Date.parse(createdAt) ||
    !Array.isArray(input.lines) ||
    input.lines.length === 0
  )
    fail("QUOTE_INPUT_INVALID");
  const brandReference = reference(input.brandReference);
  const storeReference = reference(input.storeReference);
  const currencyMetadata = createCurrencyMetadataSnapshot(input.currencyMetadata);
  let subtotal = zero(currencyMetadata.currencyCode);
  let tax = zero(currencyMetadata.currencyCode);
  const seen = new Set<string>();
  const lines = input.lines.map((line) => {
    exact(line, [
      "lineReference",
      "sellableReference",
      "productVersionReference",
      "menuVersionReference",
      "quantity",
      "priceContext",
      "taxContext",
    ]);
    const lineReference = reference(line.lineReference);
    if (
      seen.has(lineReference) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 999
    )
      fail("QUOTE_INPUT_INVALID");
    seen.add(lineReference);
    if (
      line.priceContext.brandReference !== brandReference ||
      line.priceContext.storeReference !== storeReference ||
      line.taxContext.brandReference !== brandReference ||
      line.taxContext.storeReference !== storeReference ||
      line.priceContext.sellableReference !== line.sellableReference ||
      line.priceContext.currencyCode !== currencyMetadata.currencyCode ||
      line.taxContext.currencyCode !== currencyMetadata.currencyCode ||
      line.priceContext.evaluatedAt !== createdAt ||
      line.taxContext.evaluatedAt !== createdAt
    )
      fail("QUOTE_SCOPE_MISMATCH");
    let resolvedPrice: ResolvedPrice;
    let taxResolution: TaxConfigurationResolution;
    try {
      resolvedPrice = resolvePrice(input.priceBook, line.priceContext);
      taxResolution = resolveTaxConfiguration(input.taxConfiguration, line.taxContext);
    } catch {
      return fail("QUOTE_CALCULATION_FAILED");
    }
    if (resolvedPrice.amount.currencyCode !== currencyMetadata.currencyCode)
      fail("QUOTE_CURRENCY_MISMATCH");
    const lineSubtotal = multiply(resolvedPrice.amount, line.quantity);
    let lineTax = zero(currencyMetadata.currencyCode);
    const taxLines = taxResolution.rules.map((component) => {
      if (component.resolvedRule.priceInclusion !== "Exclusive") fail("QUOTE_UNSUPPORTED_TAX_MODE");
      const basis = component.compoundOnPriorTax ? addMoney(lineSubtotal, lineTax) : lineSubtotal;
      const calculated = calculateTax({
        calculationReference: component.resolvedRule.ruleVersionReference,
        taxableReference: lineReference,
        inputAmount: basis,
        currencyMetadata,
        resolvedRule: component.resolvedRule,
      });
      lineTax = addMoney(lineTax, calculated.taxAmount);
      return Object.freeze({
        taxAmount: calculated.taxAmount,
        explanation: calculated.explanation,
        calculationOrder: component.calculationOrder,
        compoundOnPriorTax: component.compoundOnPriorTax,
        ruleReference: component.resolvedRule.ruleVersionReference,
      });
    });
    subtotal = addMoney(subtotal, lineSubtotal);
    tax = addMoney(tax, lineTax);
    const lineZero = zero(currencyMetadata.currencyCode);
    return Object.freeze({
      lineReference,
      sellableReference: reference(line.sellableReference),
      productVersionReference: reference(line.productVersionReference),
      menuVersionReference: reference(line.menuVersionReference),
      quantity: line.quantity,
      unitPrice: resolvedPrice.amount,
      subtotal: lineSubtotal,
      discount: lineZero,
      tax: lineTax,
      fee: lineZero,
      total: addMoney(lineSubtotal, lineTax),
      resolvedPrice,
      taxResolution,
      taxLines: Object.freeze(taxLines),
    });
  });
  const amountZero = zero(currencyMetadata.currencyCode);
  return Object.freeze({
    quoteReference: reference(input.quoteReference),
    quoteVersion: 1,
    brandReference,
    storeReference,
    cartReference: reference(input.cartReference),
    cartVersion: input.cartVersion,
    inputDigest: digest(input.inputDigest),
    currencyMetadata,
    subtotal,
    discount: amountZero,
    tax,
    fee: amountZero,
    total: addMoney(subtotal, tax),
    lines: Object.freeze(lines),
    appliedPromotionReferences: Object.freeze([]),
    warnings: Object.freeze([]),
    blockingReasons: Object.freeze([]),
    createdAt,
    expiresAt,
  });
}
