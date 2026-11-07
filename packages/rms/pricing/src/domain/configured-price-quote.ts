import {
  createPriceQuote,
  PriceQuoteError,
  type CreatePriceQuoteInput,
  type PriceQuoteLineSnapshot,
  type PriceQuoteSnapshot,
  type PriceQuoteTaxLine,
} from "./price-quote.js";
import { createMoney, parsePricingReference, type PricingReference } from "./money-tax-contract.js";
import { addMoney } from "./money-tax.js";
import { calculateQuoteTax } from "./quote-tax-allocation.js";
import {
  resolveOptionPrice,
  type OptionPriceRuleSnapshot,
  type OptionPriceResolution,
} from "./option-price.js";

export interface ConfiguredQuoteOptionInput {
  readonly lineReference: PricingReference;
  readonly bindingReference: PricingReference;
  readonly optionReference: PricingReference;
  readonly selectedQuantity: number;
  readonly rules: readonly OptionPriceRuleSnapshot[];
  readonly taxBasis: "ParentSellable";
  readonly taxClassificationReference: PricingReference;
}
export interface ConfiguredOptionPriceResolution extends OptionPriceResolution {
  readonly taxBasis: "ParentSellable";
  readonly taxClassificationReference: PricingReference;
}
export interface ConfiguredQuoteLineSnapshot extends PriceQuoteLineSnapshot {
  readonly optionPrices: readonly ConfiguredOptionPriceResolution[];
  readonly baseUnitPrice: PriceQuoteLineSnapshot["unitPrice"];
}
export interface ConfiguredPriceQuoteSnapshot extends Omit<
  PriceQuoteSnapshot,
  "quoteVersion" | "lines"
> {
  readonly quoteVersion: 2;
  readonly lines: readonly ConfiguredQuoteLineSnapshot[];
}
function fail(): never {
  throw new PriceQuoteError("QUOTE_INPUT_INVALID");
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  return Object.fromEntries(
    fields.map((field) => {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return fail();
      return [field, descriptor.value];
    }),
  );
}

/** Explicit same-classification Sellable taxation; does not grant Catalog or policy authority. */
export function createConfiguredPriceQuote(input: {
  readonly base: CreatePriceQuoteInput;
  readonly options: readonly ConfiguredQuoteOptionInput[];
}): ConfiguredPriceQuoteSnapshot {
  try {
    const raw = closed(input, ["base", "options"]);
    const baseInput = raw.base as CreatePriceQuoteInput;
    const base = createPriceQuote(baseInput);
    // WP-2423: a cart without options is the same quote with no Option charges, so every new
    // cart can use this one format; the amounts equal v1 (see the equivalence test).
    if (!Array.isArray(raw.options) || raw.options.length > 1000) return fail();
    const options = raw.options.map((value) => {
      const row = closed(value, [
        "lineReference",
        "bindingReference",
        "optionReference",
        "selectedQuantity",
        "rules",
        "taxBasis",
        "taxClassificationReference",
      ]);
      if (row.taxBasis !== "ParentSellable" || !Array.isArray(row.rules)) return fail();
      return {
        lineReference: parsePricingReference(row.lineReference),
        bindingReference: parsePricingReference(row.bindingReference),
        optionReference: parsePricingReference(row.optionReference),
        selectedQuantity: row.selectedQuantity as number,
        rules: row.rules as readonly OptionPriceRuleSnapshot[],
        taxClassificationReference: parsePricingReference(row.taxClassificationReference),
      };
    });
    const seen = new Set<string>();
    for (const option of options) {
      const key = [option.lineReference, option.bindingReference, option.optionReference].join(":");
      if (seen.has(key) || !base.lines.some((line) => line.lineReference === option.lineReference))
        return fail();
      seen.add(key);
    }
    let expiresAt = base.expiresAt;
    const zero = () =>
      createMoney({ amountMinor: 0n, currencyCode: base.currencyMetadata.currencyCode });
    let subtotal = zero(),
      tax = zero();
    const priced = base.lines.map((line) => {
      const source = baseInput.lines.find(
        (candidate) => candidate.lineReference === line.lineReference,
      );
      if (source === undefined) return fail();
      const optionPrices = options
        .filter((option) => option.lineReference === line.lineReference)
        .map((option) => {
          if (
            source.taxContext.chargeType !== "Sellable" ||
            source.taxContext.orderType !== source.priceContext.orderType ||
            option.taxClassificationReference !== source.taxContext.taxClassificationReference
          )
            return fail();
          const resolution = resolveOptionPrice(option.rules, {
            brandReference: base.brandReference,
            storeReference: base.storeReference,
            storeGroupReference: source.priceContext.storeGroupReference,
            regionReference: source.priceContext.regionReference,
            bindingReference: option.bindingReference,
            optionReference: option.optionReference,
            skuReference: line.sellableReference,
            channelCode: source.priceContext.channelCode,
            orderType: source.priceContext.orderType,
            currencyMetadata: base.currencyMetadata,
            selectedQuantity: option.selectedQuantity,
            itemQuantity: line.quantity,
            evaluatedAt: base.createdAt,
          });
          const end = resolution.rule.effectivePeriod.effectiveUntil?.instant;
          if (end !== undefined && end < expiresAt) expiresAt = end;
          return Object.freeze({
            ...resolution,
            taxBasis: "ParentSellable" as const,
            taxClassificationReference: option.taxClassificationReference,
          });
        });
      let unitPrice = line.unitPrice;
      for (const option of optionPrices) {
        unitPrice = addMoney(
          unitPrice,
          createMoney({
            amountMinor: option.rule.unitAmount.amountMinor * BigInt(option.chargedQuantityPerItem),
            currencyCode: base.currencyMetadata.currencyCode,
          }),
        );
      }
      const lineSubtotal = createMoney({
        amountMinor: unitPrice.amountMinor * BigInt(line.quantity),
        currencyCode: base.currencyMetadata.currencyCode,
      });
      for (const component of line.taxResolution.rules)
        if (component.resolvedRule.priceInclusion !== "Exclusive")
          throw new PriceQuoteError("QUOTE_UNSUPPORTED_TAX_MODE");
      return { line, optionPrices, unitPrice, lineSubtotal };
    });
    // WP-2423 DEC-TAX-WHOLE-RECEIPT: tax per tax type on the whole quote, allocated to the lines.
    const allocated = calculateQuoteTax(
      priced.map((entry) => ({
        lineReference: entry.line.lineReference,
        subtotal: entry.lineSubtotal,
        rules: entry.line.taxResolution.rules,
      })),
      base.currencyMetadata,
      "WholeQuote",
    );
    const lines = priced.map((entry, index): ConfiguredQuoteLineSnapshot => {
      const taxLines: PriceQuoteTaxLine[] = [...(allocated[index] ?? [])];
      const lineTax = taxLines.reduce((sum, value) => addMoney(sum, value.taxAmount), zero());
      subtotal = addMoney(subtotal, entry.lineSubtotal);
      tax = addMoney(tax, lineTax);
      return Object.freeze({
        ...entry.line,
        baseUnitPrice: entry.line.unitPrice,
        optionPrices: Object.freeze(entry.optionPrices),
        unitPrice: entry.unitPrice,
        subtotal: entry.lineSubtotal,
        tax: lineTax,
        total: addMoney(entry.lineSubtotal, lineTax),
        taxLines: Object.freeze(taxLines),
      });
    });
    return Object.freeze({
      ...base,
      quoteVersion: 2,
      lines: Object.freeze(lines),
      subtotal,
      tax,
      total: addMoney(subtotal, tax),
      expiresAt,
    });
  } catch (error) {
    if (error instanceof PriceQuoteError) throw error;
    throw new PriceQuoteError("QUOTE_CALCULATION_FAILED");
  }
}
