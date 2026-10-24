import { readClosedRecord } from "@bop/identity";
import {
  encodeConfiguredPriceQuoteSnapshot,
  decodeConfiguredPriceQuoteSnapshot,
  type PriceQuoteHistoryReader,
  type ConfiguredPriceQuoteSnapshot,
} from "@rms/pricing";
import { parseConfiguredCheckoutValidationEvidence } from "../domain/checkout-validation.js";
import { parseOrderingReference, parseOrderingInstant } from "../domain/cart.js";
import { parseConfiguredOrderPricingLineSnapshot } from "../domain/order-item-snapshot.js";

class ConfiguredOrderPricingSourceError extends Error {
  readonly code = "ORDER_PRICING_SOURCE_UNAVAILABLE";
  constructor() {
    super("order pricing source is unavailable");
    this.name = "OrderPricingSourceError";
  }
}

/** Original quote amounts only. Caller owns current Guest authorization and final readiness. */
export function createConfiguredOrderPricingSource(options: {
  readonly history: PriceQuoteHistoryReader<ConfiguredPriceQuoteSnapshot>;
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly clock: Readonly<{ now(): string }>;
}) {
  const scope = readClosedRecord(
    options.scope,
    ["brandReference", "storeReference"],
    "ACTOR_SHAPE_INVALID",
  );
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  return Object.freeze({
    async load(input: { readonly evidence: unknown }) {
      try {
        const raw = readClosedRecord(input, ["evidence"], "ACTOR_SHAPE_INVALID");
        const evidence = parseConfiguredCheckoutValidationEvidence(raw.evidence);
        const started = parseOrderingInstant(options.clock.now());
        if (
          evidence.brandReference !== brand ||
          evidence.storeReference !== store ||
          started < evidence.validatedAt ||
          started >= evidence.validUntil
        )
          throw new ConfiguredOrderPricingSourceError();
        const original = await options.history.load(evidence.quoteReference);
        if (original === null) throw new ConfiguredOrderPricingSourceError();
        const quote = decodeConfiguredPriceQuoteSnapshot(
          encodeConfiguredPriceQuoteSnapshot(original),
        );
        const finished = parseOrderingInstant(options.clock.now());
        if (
          finished < started ||
          finished >= evidence.validUntil ||
          finished >= quote.expiresAt ||
          quote.createdAt > started ||
          quote.createdAt > evidence.validatedAt ||
          String(quote.brandReference) !== brand ||
          String(quote.storeReference) !== store ||
          String(quote.cartReference) !== evidence.cartReference ||
          quote.cartVersion !== evidence.cartVersion ||
          String(quote.quoteReference) !== evidence.quoteReference ||
          quote.quoteVersion !== evidence.quoteVersion ||
          String(quote.inputDigest) !== evidence.quoteInputDigest ||
          quote.blockingReasons.length !== 0 ||
          quote.lines.length !== evidence.catalogLines.length
        )
          throw new ConfiguredOrderPricingSourceError();
        const expected = new Map(
          evidence.catalogLines.map((line) => [String(line.cartItemReference), line]),
        );
        if (expected.size !== quote.lines.length) throw new ConfiguredOrderPricingSourceError();
        return Object.freeze(
          quote.lines.map((line) => {
            const catalog = expected.get(line.lineReference);
            if (
              !catalog ||
              String(line.sellableReference) !== catalog.sellableReference ||
              String(line.productVersionReference) !== catalog.productVersionReference ||
              String(line.menuVersionReference) !== catalog.menuVersionReference
            )
              throw new ConfiguredOrderPricingSourceError();
            const price = line.resolvedPrice,
              tax = line.taxResolution;
            return parseConfiguredOrderPricingLineSnapshot({
              quoteReference: quote.quoteReference,
              quoteVersion: quote.quoteVersion,
              optionPrices: line.optionPrices.map((option) => ({
                ruleReference: option.rule.ruleReference,
                ruleVersionReference: option.rule.versionReference,
                ruleDigest: option.rule.snapshotDigest,
                bindingReference: option.rule.bindingReference,
                optionReference: option.rule.optionReference,
                brandReference: option.context.brandReference,
                storeReference: option.context.storeReference,
                sellableReference: option.skuReference,
                storeGroupReference: option.context.storeGroupReference,
                regionReference: option.context.regionReference,
                channelCode: option.context.channelCode,
                orderType: option.context.orderType,
                ruleSkuReference: option.rule.skuReference,
                scopeKind: option.rule.scopeKind,
                scopeReference: option.rule.scopeReference,
                ruleChannelCode: option.rule.channelCode,
                ruleOrderType: option.rule.orderType,
                priority: option.priority,
                selectedQuantity: option.selectedQuantity,
                includedQuantity: option.rule.includedQuantity,
                chargedQuantityPerItem: option.chargedQuantityPerItem,
                chargedQuantity: option.chargedQuantity,
                quantityBasis: option.rule.quantityBasis,
                unitPrice: option.rule.unitAmount,
                subtotal: option.amount,
                taxBasis: option.taxBasis,
                taxClassificationReference: option.taxClassificationReference,
                effectiveFrom: option.rule.effectivePeriod.effectiveFrom.instant,
                effectiveUntil: option.rule.effectivePeriod.effectiveUntil?.instant ?? null,
                ruleCreatedAt: option.rule.createdAt,
              })),
              quoteInputDigest: quote.inputDigest,
              lineReference: line.lineReference,
              sellableReference: line.sellableReference,
              quantity: line.quantity,
              currencyMinorUnitExponent: quote.currencyMetadata.minorUnitExponent,
              currencyMetadataVersion: quote.currencyMetadata.metadataVersion,
              currencyMetadataVersionReference: quote.currencyMetadata.metadataVersionReference,
              currencyMetadataDigest: quote.currencyMetadata.metadataDigest,
              unitPrice: line.unitPrice,
              subtotal: line.subtotal,
              discount: line.discount,
              tax: line.tax,
              fee: line.fee,
              total: line.total,
              priceResolution: {
                priceBookReference: price.priceBookReference,
                priceBookVersionReference: price.versionReference,
                priceBookDigest: price.snapshotDigest,
                priceEntryReference: price.entryReference,
                unitPrice: price.amount,
                scopeKind: price.scopeKind,
                scopeReference: price.scopeReference,
                channelCode: price.channelCode,
                orderType: price.orderType,
                priority: price.priority,
                effectiveFrom: price.effectivePeriod.effectiveFrom.instant,
                effectiveUntil: price.effectivePeriod.effectiveUntil?.instant ?? null,
                reasonCode: price.reasonCode,
              },
              taxConfigurationReference: tax.configurationReference,
              taxConfigurationVersionReference: tax.versionReference,
              taxConfigurationDigest: tax.snapshotDigest,
              taxEffectiveFrom: tax.effectivePeriod.effectiveFrom.instant,
              taxEffectiveUntil: tax.effectivePeriod.effectiveUntil?.instant ?? null,
              taxComponents: line.taxLines.map((component) => ({
                ruleVersionReference: component.explanation.ruleVersionReference,
                ruleVersionDigest: component.explanation.ruleVersionDigest,
                jurisdictionCode: component.explanation.jurisdictionCode,
                taxComponentCode: component.explanation.taxComponentCode,
                taxClassificationReference: component.explanation.taxClassificationReference,
                treatment: component.explanation.treatment,
                rate: component.explanation.rate,
                priceInclusion: component.explanation.priceInclusion,
                roundingMode: component.explanation.roundingMode,
                calculationOrder: component.calculationOrder,
                compoundOnPriorTax: component.compoundOnPriorTax,
                taxAmount: component.taxAmount,
              })),
              quotedAt: quote.createdAt,
            });
          }),
        );
      } catch {
        throw new ConfiguredOrderPricingSourceError();
      }
    },
  });
}
