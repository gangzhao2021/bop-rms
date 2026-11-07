import { readClosedRecord } from "@bop/identity";
import {
  encodePriceQuoteSnapshot,
  decodePriceQuoteSnapshot,
  type PriceQuoteHistoryReader,
} from "@rms/pricing";
import { parseCheckoutValidationEvidence } from "../domain/checkout-validation.js";
import { parseOrderingReference, parseOrderingInstant } from "../domain/cart.js";
import { parseOrderPricingLineSnapshot } from "../domain/order-item-snapshot.js";

export class OrderPricingSourceError extends Error {
  readonly code = "ORDER_PRICING_SOURCE_UNAVAILABLE";
  constructor() {
    super("order pricing source is unavailable");
    this.name = "OrderPricingSourceError";
  }
}

/** Original quote amounts only. Caller owns current Guest authorization and final readiness. */
export function createOrderPricingSource(options: {
  readonly history: PriceQuoteHistoryReader;
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
        const evidence = parseCheckoutValidationEvidence(raw.evidence);
        const started = parseOrderingInstant(options.clock.now());
        if (
          evidence.brandReference !== brand ||
          evidence.storeReference !== store ||
          started < evidence.validatedAt ||
          started >= evidence.validUntil
        )
          throw new OrderPricingSourceError();
        const original = await options.history.load(evidence.quoteReference);
        if (original === null) throw new OrderPricingSourceError();
        const quote = decodePriceQuoteSnapshot(encodePriceQuoteSnapshot(original));
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
          throw new OrderPricingSourceError();
        const expected = new Map(
          evidence.catalogLines.map((line) => [String(line.cartItemReference), line]),
        );
        if (expected.size !== quote.lines.length) throw new OrderPricingSourceError();
        return Object.freeze(
          quote.lines.map((line) => {
            const catalog = expected.get(line.lineReference);
            if (
              !catalog ||
              String(line.sellableReference) !== catalog.sellableReference ||
              String(line.productVersionReference) !== catalog.productVersionReference ||
              String(line.menuVersionReference) !== catalog.menuVersionReference
            )
              throw new OrderPricingSourceError();
            const price = line.resolvedPrice,
              tax = line.taxResolution;
            return parseOrderPricingLineSnapshot({
              quoteReference: quote.quoteReference,
              quoteVersion: quote.quoteVersion,
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
        throw new OrderPricingSourceError();
      }
    },
  });
}
