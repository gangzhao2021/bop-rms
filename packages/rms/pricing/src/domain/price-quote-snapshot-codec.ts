import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";
import {
  createCurrencyMetadataSnapshot,
  createMoney,
  createResolvedTaxRuleSnapshot,
  parseCurrencyCode,
  parseAmountMinor,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  type CurrencyMetadataSnapshot,
  type ResolvedTaxRuleSnapshot,
} from "./money-tax-contract.js";
import { calculateTax } from "./money-tax.js";
import type { PriceQuoteSnapshot } from "./price-quote.js";

export class PriceQuoteSnapshotCodecError extends Error {
  readonly code = "QUOTE_SNAPSHOT_INVALID";
  constructor() {
    super("price quote snapshot is invalid");
    this.name = "PriceQuoteSnapshotCodecError";
  }
}

function fail(): never {
  throw new PriceQuoteSnapshotCodecError();
}
const maximumBytes = 16 * 1024 * 1024;
type Reader = (value: unknown) => unknown;
const integer: Reader = (v) => (Number.isSafeInteger(v) && !Object.is(v, -0) ? v : fail());
const positive: Reader = (v) => (typeof integer(v) === "number" && (v as number) > 0 ? v : fail());
const bool: Reader = (v) => (typeof v === "boolean" ? v : fail());
const oneOf =
  (...values: unknown[]): Reader =>
  (v) =>
    values.includes(v) ? v : fail();
const nullable =
  (read: Reader): Reader =>
  (v) =>
    v === null ? null : read(v);
const at: Reader = (v) => {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    fail();
  return v;
};
function object(fields: Record<string, Reader>): Reader {
  return (v) => {
    if (
      v === null ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.getPrototypeOf(v) !== Object.prototype
    )
      fail();
    const source = v as Record<string, unknown>;
    const keys = Object.keys(source);
    if (
      keys.length !== Object.keys(fields).length ||
      keys.some((key) => !Object.hasOwn(fields, key))
    )
      fail();
    return Object.freeze(
      Object.fromEntries(Object.entries(fields).map(([key, read]) => [key, read(source[key])])),
    );
  };
}
function array(read: Reader, minimum = 0, maximum = 1000): Reader {
  return (v) => {
    if (!Array.isArray(v) || v.length < minimum || v.length > maximum) fail();
    return Object.freeze((v as unknown[]).map(read));
  };
}
const money = object({
  amountMinor: (v) => {
    if (typeof v !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(v)) fail();
    return parseAmountMinor(BigInt(v as string));
  },
  currencyCode: parseCurrencyCode,
});
const metadata: Reader = (v) => createCurrencyMetadataSnapshot(v as CurrencyMetadataSnapshot);
const period: Reader = (v) => createEffectivePeriod(v as EffectivePeriod);
const rule: Reader = (v) => createResolvedTaxRuleSnapshot(v as ResolvedTaxRuleSnapshot);
const resolvedPrice = object({
  priceBookReference: parsePricingReference,
  versionReference: parsePricingReference,
  snapshotDigest: parsePricingDigest,
  entryReference: parsePricingReference,
  sellableReference: parsePricingReference,
  amount: money,
  scopeKind: oneOf("Brand", "Region", "StoreGroup", "Store"),
  scopeReference: nullable(parsePricingReference),
  channelCode: nullable(parsePricingCode),
  orderType: nullable(oneOf("DineIn", "Pickup")),
  priority: positive,
  effectivePeriod: period,
  reasonCode: parsePricingCode,
});
const resolution = object({
  configurationReference: parsePricingReference,
  versionReference: parsePricingReference,
  snapshotDigest: parsePricingDigest,
  effectivePeriod: period,
  rules: array(
    object({
      calculationOrder: positive,
      compoundOnPriorTax: bool,
      receiptPresentationCode: parsePricingCode,
      resolvedRule: rule,
    }),
    1,
  ),
});
const explanation = object({
  jurisdictionCode: parsePricingCode,
  taxComponentCode: parsePricingCode,
  taxClassificationReference: parsePricingReference,
  treatment: oneOf("Taxable", "Exempt", "ZeroRated"),
  rate: (v) => (typeof v === "string" ? v : fail()),
  rateNumerator: (v) => (typeof v === "string" ? v : fail()),
  rateDenominator: (v) => (typeof v === "string" ? v : fail()),
  priceInclusion: oneOf("Exclusive"),
  roundingMode: oneOf("HalfUp", "HalfEven", "TowardZero", "AwayFromZero"),
  currencyMetadataVersion: positive,
  currencyMetadataVersionReference: parsePricingReference,
  currencyMetadataDigest: parsePricingDigest,
  ruleVersionReference: parsePricingReference,
  ruleVersionDigest: parsePricingDigest,
});
const amounts = { subtotal: money, discount: money, tax: money, fee: money, total: money };
const snapshot = object({
  quoteReference: parsePricingReference,
  quoteVersion: oneOf(1),
  brandReference: parsePricingReference,
  storeReference: parsePricingReference,
  cartReference: parsePricingReference,
  cartVersion: positive,
  inputDigest: parsePricingDigest,
  currencyMetadata: metadata,
  ...amounts,
  lines: array(
    object({
      lineReference: parsePricingReference,
      sellableReference: parsePricingReference,
      productVersionReference: parsePricingReference,
      menuVersionReference: parsePricingReference,
      quantity: positive,
      unitPrice: money,
      ...amounts,
      resolvedPrice,
      taxResolution: resolution,
      taxLines: array(
        object({
          taxAmount: money,
          explanation,
          calculationOrder: positive,
          compoundOnPriorTax: bool,
          ruleReference: parsePricingReference,
        }),
        1,
      ),
    }),
    1,
  ),
  appliedPromotionReferences: array(parsePricingReference, 0, 0),
  warnings: array(parsePricingCode, 0, 0),
  blockingReasons: array(parsePricingCode, 0, 0),
  createdAt: at,
  expiresAt: at,
});

// Copy data through descriptors before invoking validators or JSON. No getters/toJSON are read.
// Repeated immutable Money instances are valid; only cycles along the current path are rejected.
function wireTree(value: unknown, native: boolean): unknown {
  let count = 0;
  let characters = 0;
  const path = new Set<object>();
  function visit(v: unknown, depth: number, key: string): unknown {
    if (++count > 100_000 || depth > 24) fail();
    if (key === "amountMinor") {
      if (native && typeof v !== "bigint") fail();
      if (!native && typeof v !== "string") fail();
      return typeof v === "bigint" ? v.toString() : v;
    }
    if (v === null || typeof v === "boolean" || typeof v === "string") {
      if (typeof v === "string") characters += v.length;
      if (characters > maximumBytes) fail();
      return v;
    }
    if (typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0)) return v;
    if (typeof v !== "object" || v === null || path.has(v)) fail();
    const obj = v as object;
    const isArray = Array.isArray(obj);
    if (Object.getPrototypeOf(obj) !== (isArray ? Array.prototype : Object.prototype)) fail();
    if (isArray && (obj as unknown[]).length > 1000) fail();
    const keys = Reflect.ownKeys(obj);
    if (keys.length > 100_000 - count) fail();
    for (const key of keys) {
      if (typeof key === "string") characters += key.length;
    }
    if (characters > maximumBytes) fail();
    const descriptors = Object.getOwnPropertyDescriptors(obj);
    if (
      keys.some(
        (k) =>
          typeof k !== "string" ||
          !("value" in (descriptors[k] ?? {})) ||
          (k !== "length" && descriptors[k]?.enumerable !== true),
      )
    )
      fail();
    path.add(obj);
    let result: unknown;
    if (isArray) {
      const length = (obj as unknown[]).length;
      if (
        length > 1000 ||
        keys.length !== length + 1 ||
        keys.some((k) => k !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(k as string))
      )
        fail();
      result = Array.from({ length }, (_, i) =>
        visit(descriptors[String(i)]?.value, depth + 1, ""),
      );
    } else {
      result = Object.fromEntries(
        (keys as string[]).sort().map((k) => [k, visit(descriptors[k]?.value, depth + 1, k)]),
      );
    }
    path.delete(obj);
    return result;
  }
  return visit(value, 0, "");
}
function canonical(value: unknown): string {
  const text = JSON.stringify(wireTree(value, true));
  if (new TextEncoder().encode(text).byteLength > maximumBytes) fail();
  return text;
}
function effective(p: EffectivePeriod, createdAt: string): void {
  if (
    createdAt < p.effectiveFrom.instant ||
    (p.effectiveUntil !== null && createdAt >= p.effectiveUntil.instant)
  )
    fail();
}
function validate(value: unknown): PriceQuoteSnapshot {
  const quote = snapshot(value) as PriceQuoteSnapshot;
  if (quote.expiresAt <= quote.createdAt) fail();
  const currency = quote.currencyMetadata.currencyCode;
  let subtotal = 0n;
  let tax = 0n;
  const seen = new Set<string>();
  const entries = new Map<string, string>();
  const ruleEvidence = new Map<string, string>();
  const first = quote.lines[0];
  if (first === undefined) fail();
  for (const line of quote.lines) {
    if (seen.has(line.lineReference) || line.quantity > 999) fail();
    seen.add(line.lineReference);
    const price = line.resolvedPrice;
    const initialPrice = first.resolvedPrice;
    const initialTax = first.taxResolution;
    const taxResolution = line.taxResolution;
    if (
      price.priceBookReference !== initialPrice.priceBookReference ||
      price.versionReference !== initialPrice.versionReference ||
      price.snapshotDigest !== initialPrice.snapshotDigest ||
      taxResolution.configurationReference !== initialTax.configurationReference ||
      taxResolution.versionReference !== initialTax.versionReference ||
      taxResolution.snapshotDigest !== initialTax.snapshotDigest ||
      canonical(taxResolution.effectivePeriod) !== canonical(initialTax.effectivePeriod)
    )
      fail();
    const entry = canonical(price);
    if (entries.has(price.entryReference) && entries.get(price.entryReference) !== entry) fail();
    entries.set(price.entryReference, entry);
    effective(price.effectivePeriod, quote.createdAt);
    effective(line.taxResolution.effectivePeriod, quote.createdAt);
    const base = { Store: 1, StoreGroup: 3, Region: 5, Brand: 7 }[price.scopeKind];
    if (
      price.priority !== base + (price.channelCode === null && price.orderType === null ? 1 : 0) ||
      (price.scopeKind === "Brand") !== (price.scopeReference === null) ||
      (price.scopeKind === "Store" && price.scopeReference !== quote.storeReference) ||
      price.sellableReference !== line.sellableReference ||
      price.amount.amountMinor !== line.unitPrice.amountMinor ||
      line.subtotal.amountMinor !== line.unitPrice.amountMinor * BigInt(line.quantity) ||
      line.taxLines.length !== line.taxResolution.rules.length
    )
      fail();
    let lineTax = 0n;
    let order = 0;
    const rules = new Set<string>();
    const components = new Set<string>();
    const firstRule = line.taxResolution.rules[0]?.resolvedRule;
    if (firstRule === undefined) fail();
    for (const [index, component] of line.taxResolution.rules.entries()) {
      const recorded = line.taxLines[index];
      const resolvedRule = component.resolvedRule;
      if (
        recorded === undefined ||
        component.calculationOrder !== order + 1 ||
        component.calculationOrder > 16 ||
        (index === 0 && component.compoundOnPriorTax) ||
        rules.has(resolvedRule.ruleVersionReference) ||
        resolvedRule.priceInclusion !== "Exclusive" ||
        resolvedRule.ruleVersionDigest !== line.taxResolution.snapshotDigest ||
        recorded.ruleReference !== resolvedRule.ruleVersionReference ||
        recorded.calculationOrder !== component.calculationOrder ||
        recorded.compoundOnPriorTax !== component.compoundOnPriorTax
      )
        fail();
      if (
        resolvedRule.taxClassificationReference !== firstRule.taxClassificationReference ||
        resolvedRule.jurisdictionCode !== firstRule.jurisdictionCode ||
        components.has(resolvedRule.taxComponentCode)
      )
        fail();
      if (
        resolvedRule.jurisdictionCode !==
        first.taxResolution.rules[0]?.resolvedRule.jurisdictionCode
      )
        fail();
      const evidence = canonical(component);
      if (
        ruleEvidence.has(resolvedRule.ruleVersionReference) &&
        ruleEvidence.get(resolvedRule.ruleVersionReference) !== evidence
      )
        fail();
      ruleEvidence.set(resolvedRule.ruleVersionReference, evidence);
      components.add(resolvedRule.taxComponentCode);
      order = component.calculationOrder;
      rules.add(resolvedRule.ruleVersionReference);
      const calculated = calculateTax({
        calculationReference: resolvedRule.ruleVersionReference,
        taxableReference: line.lineReference,
        inputAmount: createMoney({
          currencyCode: currency,
          amountMinor: line.subtotal.amountMinor + (component.compoundOnPriorTax ? lineTax : 0n),
        }),
        currencyMetadata: quote.currencyMetadata,
        resolvedRule,
      });
      if (
        recorded.taxAmount.currencyCode !== currency ||
        recorded.taxAmount.amountMinor !== calculated.taxAmount.amountMinor ||
        canonical(recorded.explanation) !== canonical(calculated.explanation)
      )
        fail();
      lineTax += recorded.taxAmount.amountMinor;
    }
    for (const amount of [
      line.unitPrice,
      price.amount,
      line.subtotal,
      line.discount,
      line.tax,
      line.fee,
      line.total,
    ]) {
      if (amount.currencyCode !== currency) fail();
    }
    if (
      line.discount.amountMinor !== 0n ||
      line.fee.amountMinor !== 0n ||
      line.tax.amountMinor !== lineTax ||
      line.total.amountMinor !== line.subtotal.amountMinor + lineTax
    )
      fail();
    subtotal += line.subtotal.amountMinor;
    tax += lineTax;
  }
  for (const amount of [quote.subtotal, quote.discount, quote.tax, quote.fee, quote.total]) {
    if (amount.currencyCode !== currency) fail();
  }
  if (
    quote.discount.amountMinor !== 0n ||
    quote.fee.amountMinor !== 0n ||
    quote.subtotal.amountMinor !== subtotal ||
    quote.tax.amountMinor !== tax ||
    quote.total.amountMinor !== subtotal + tax
  )
    fail();
  return quote;
}

/** Complete v1 factory evidence only. This is not an authorization or provenance attestation. */
export function encodePriceQuoteSnapshot(value: PriceQuoteSnapshot): string {
  try {
    const quote = validate(wireTree(value, true));
    return canonical({ codecVersion: 1, snapshot: quote });
  } catch {
    return fail();
  }
}

/** Accept only the canonical text emitted by this codec; reject duplicate keys and alternative encodings. */
export function decodePriceQuoteSnapshot(text: string): PriceQuoteSnapshot {
  try {
    if (
      typeof text !== "string" ||
      text.length > maximumBytes ||
      new TextEncoder().encode(text).byteLength > maximumBytes
    )
      fail();
    const envelope = object({ codecVersion: oneOf(1), snapshot: (v) => v })(
      wireTree(JSON.parse(text), false),
    ) as { snapshot: unknown };
    const quote = validate(envelope.snapshot);
    if (canonical({ codecVersion: 1, snapshot: quote }) !== text) fail();
    return quote;
  } catch {
    return fail();
  }
}
