import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";
import {
  createCurrencyMetadataSnapshot,
  createResolvedTaxRuleSnapshot,
  createMoney,
  parseAmountMinor,
  parseCurrencyCode,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  type CurrencyMetadataSnapshot,
  type ResolvedTaxRuleSnapshot,
} from "./money-tax-contract.js";
import { calculateTax } from "./money-tax.js";
import type { PriceQuoteSnapshot } from "./price-quote.js";

export class PriceQuoteSnapshotError extends Error {
  readonly code = "QUOTE_SNAPSHOT_INVALID";
  constructor() {
    super("quote snapshot is invalid");
    this.name = "PriceQuoteSnapshotError";
  }
}
const fail = (): never => {
  throw new PriceQuoteSnapshotError();
};
type Parser<T> = (value: unknown) => T;

// Inspect descriptors before reading values: no getters, custom prototypes, sparse arrays or cycles.
// This helper is internal to Pricing; it is not exported through the package index.
export function copyQuoteSnapshotValue(value: unknown, depth = 0): unknown {
  if (depth > 32) return fail();
  if (value === null || ["string", "boolean", "bigint"].includes(typeof value)) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : fail();
  if (typeof value !== "object") return fail();
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (array) {
    if (keys.length !== value.length + 1) return fail();
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
      return copyQuoteSnapshotValue(descriptor.value, depth + 1);
    });
  }
  return Object.fromEntries(
    keys.map((key) => {
      if (typeof key !== "string") return fail();
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
      return [key, copyQuoteSnapshotValue(descriptor.value, depth + 1)];
    }),
  );
}

function shape<S extends Record<string, Parser<unknown>>>(
  fields: S,
): Parser<{ readonly [K in keyof S]: ReturnType<S[K]> }> {
  return (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
    const source = value as Record<string, unknown>;
    if (
      Object.keys(source).length !== Object.keys(fields).length ||
      Object.keys(source).some((key) => !Object.hasOwn(fields, key))
    )
      return fail();
    return Object.freeze(
      Object.fromEntries(Object.entries(fields).map(([key, parser]) => [key, parser(source[key])])),
    ) as { readonly [K in keyof S]: ReturnType<S[K]> };
  };
}
const list =
  <T>(parser: Parser<T>): Parser<readonly T[]> =>
  (value) => {
    if (!Array.isArray(value)) return fail();
    return Object.freeze(value.map(parser));
  };
const nullable =
  <T>(parser: Parser<T>): Parser<T | null> =>
  (value) =>
    value === null ? null : parser(value);
const choice =
  <T extends string | number>(...values: readonly T[]): Parser<T> =>
  (value) =>
    values.includes(value as T) ? (value as T) : fail();
const integer =
  (max: number): Parser<number> =>
  (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max
      ? value
      : fail();
const boolean: Parser<boolean> = (value) => (typeof value === "boolean" ? value : fail());
const at: Parser<string> = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
};
const money = shape({
  amountMinor: (value: unknown) => {
    const amount = parseAmountMinor(value);
    return amount >= 0n ? amount : fail();
  },
  currencyCode: parseCurrencyCode,
});
const period = (value: unknown) => createEffectivePeriod(value as EffectivePeriod);
const metadata = (value: unknown) =>
  createCurrencyMetadataSnapshot(value as CurrencyMetadataSnapshot);
const rule = (value: unknown) => createResolvedTaxRuleSnapshot(value as ResolvedTaxRuleSnapshot);
const empty: Parser<readonly never[]> = (value) =>
  Array.isArray(value) && value.length === 0 ? Object.freeze([]) : fail();
const amounts = { subtotal: money, discount: money, tax: money, fee: money, total: money };
const resolvedPrice = shape({
  priceBookReference: parsePricingReference,
  versionReference: parsePricingReference,
  snapshotDigest: parsePricingDigest,
  entryReference: parsePricingReference,
  sellableReference: parsePricingReference,
  amount: money,
  scopeKind: choice("Brand", "Region", "StoreGroup", "Store"),
  scopeReference: nullable(parsePricingReference),
  channelCode: nullable(parsePricingCode),
  orderType: nullable(choice("DineIn", "Pickup")),
  priority: integer(8),
  effectivePeriod: period,
  reasonCode: parsePricingCode,
});
const resolution = shape({
  configurationReference: parsePricingReference,
  versionReference: parsePricingReference,
  snapshotDigest: parsePricingDigest,
  effectivePeriod: period,
  rules: list(
    shape({
      calculationOrder: integer(16),
      compoundOnPriorTax: boolean,
      receiptPresentationCode: parsePricingCode,
      resolvedRule: rule,
    }),
  ),
});
const line = shape({
  lineReference: parsePricingReference,
  sellableReference: parsePricingReference,
  productVersionReference: parsePricingReference,
  menuVersionReference: parsePricingReference,
  quantity: integer(999),
  unitPrice: money,
  ...amounts,
  resolvedPrice,
  taxResolution: resolution,
  taxLines: list(
    shape({
      taxAmount: money,
      explanation: (value: unknown) => value,
      calculationOrder: integer(16),
      compoundOnPriorTax: boolean,
      ruleReference: parsePricingReference,
    }),
  ),
});
const snapshot = shape({
  quoteReference: parsePricingReference,
  quoteVersion: choice(1),
  brandReference: parsePricingReference,
  storeReference: parsePricingReference,
  cartReference: parsePricingReference,
  cartVersion: integer(Number.MAX_SAFE_INTEGER),
  inputDigest: parsePricingDigest,
  currencyMetadata: metadata,
  ...amounts,
  lines: list(line),
  appliedPromotionReferences: empty,
  warnings: empty,
  blockingReasons: empty,
  createdAt: at,
  expiresAt: at,
});
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  );
}
function active(periodValue: EffectivePeriod, instant: string): void {
  if (
    instant < periodValue.effectiveFrom.instant ||
    (periodValue.effectiveUntil !== null && instant >= periodValue.effectiveUntil.instant)
  )
    fail();
}

/** Validates existing Phase-1 immutable evidence without looking up mutable source facts. */
export function parsePriceQuoteSnapshot(value: unknown): PriceQuoteSnapshot {
  try {
    const quote = snapshot(copyQuoteSnapshotValue(value));
    if (quote.lines.length === 0 || quote.expiresAt <= quote.createdAt) return fail();
    const currency = quote.currencyMetadata.currencyCode;
    const seen = new Set<string>();
    let subtotal = 0n,
      tax = 0n;
    const lines = quote.lines.map((item) => {
      if (seen.has(item.lineReference)) return fail();
      seen.add(item.lineReference);
      const price = item.resolvedPrice;
      const scopeBase = { Store: 1, StoreGroup: 3, Region: 5, Brand: 7 }[price.scopeKind];
      const qualified = price.channelCode !== null || price.orderType !== null;
      if (
        price.priority !== scopeBase + (qualified ? 0 : 1) ||
        (price.scopeKind === "Brand") !== (price.scopeReference === null) ||
        (price.scopeKind === "Store" && price.scopeReference !== quote.storeReference)
      )
        return fail();
      if (price.sellableReference !== item.sellableReference || !same(price.amount, item.unitPrice))
        return fail();
      active(price.effectivePeriod, quote.createdAt);
      active(item.taxResolution.effectivePeriod, quote.createdAt);
      for (const amount of [
        item.unitPrice,
        ...Object.keys(amounts).map((key) => item[key as keyof typeof amounts]),
      ])
        if (amount.currencyCode !== currency) return fail();
      if (
        item.discount.amountMinor !== 0n ||
        item.fee.amountMinor !== 0n ||
        item.subtotal.amountMinor !== item.unitPrice.amountMinor * BigInt(item.quantity)
      )
        return fail();
      const rules = item.taxResolution.rules;
      if (
        rules.length === 0 ||
        rules.length !== item.taxLines.length ||
        new Set(rules.map((component) => component.resolvedRule.ruleVersionReference)).size !==
          rules.length ||
        new Set(rules.map((component) => component.resolvedRule.taxComponentCode)).size !==
          rules.length
      )
        return fail();
      let lineTax = 0n;
      const taxLines = item.taxLines.map((taxLine, index) => {
        const component = rules[index];
        if (
          !component ||
          component.calculationOrder !== index + 1 ||
          component.resolvedRule.ruleVersionDigest !== item.taxResolution.snapshotDigest ||
          component.resolvedRule.priceInclusion !== "Exclusive"
        )
          return fail();
        const calculated = calculateTax({
          calculationReference: component.resolvedRule.ruleVersionReference,
          taxableReference: item.lineReference,
          currencyMetadata: quote.currencyMetadata,
          inputAmount: createMoney({
            amountMinor: item.subtotal.amountMinor + (component.compoundOnPriorTax ? lineTax : 0n),
            currencyCode: currency,
          }),
          resolvedRule: component.resolvedRule,
        });
        if (
          !same(taxLine.taxAmount, calculated.taxAmount) ||
          !same(taxLine.explanation, calculated.explanation) ||
          taxLine.ruleReference !== component.resolvedRule.ruleVersionReference ||
          taxLine.calculationOrder !== component.calculationOrder ||
          taxLine.compoundOnPriorTax !== component.compoundOnPriorTax
        )
          return fail();
        lineTax += taxLine.taxAmount.amountMinor;
        return Object.freeze({ ...taxLine, explanation: calculated.explanation });
      });
      if (
        item.tax.amountMinor !== lineTax ||
        item.total.amountMinor !== item.subtotal.amountMinor + lineTax
      )
        return fail();
      subtotal += item.subtotal.amountMinor;
      tax += lineTax;
      return Object.freeze({ ...item, taxLines: Object.freeze(taxLines) });
    });
    for (const amount of Object.keys(amounts).map((key) => quote[key as keyof typeof amounts]))
      if (amount.currencyCode !== currency) return fail();
    if (
      quote.subtotal.amountMinor !== subtotal ||
      quote.tax.amountMinor !== tax ||
      quote.discount.amountMinor !== 0n ||
      quote.fee.amountMinor !== 0n ||
      quote.total.amountMinor !== subtotal + tax
    )
      return fail();
    return Object.freeze({ ...quote, lines: Object.freeze(lines) });
  } catch {
    return fail();
  }
}
