import { readClosedRecord } from "@bop/identity";
import {
  decodeConfiguredPriceQuoteSnapshot,
  encodeConfiguredPriceQuoteSnapshot,
  parsePricingCode,
  type ConfiguredPriceQuoteSnapshot,
} from "@rms/pricing";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
} from "../domain/cart.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import { parseOrderCatalogLineSnapshot } from "../domain/order-item-snapshot.js";

function invalid(): never {
  throw new CartError("CART_QUOTE_INVALID");
}

/** Evidence matching only. Caller must supply current Guest authorization and actual Catalog facts. */
export function bindConfiguredCartQuote(input: {
  readonly cart: unknown;
  readonly quote: unknown;
  readonly catalogLines: readonly unknown[];
  readonly pricingChannelCode: unknown;
  readonly observedAt: unknown;
}): ConfiguredPriceQuoteSnapshot {
  try {
    const raw = readClosedRecord(input, [
      "cart",
      "quote",
      "catalogLines",
      "pricingChannelCode",
      "observedAt",
    ]);
    const cart = parseCartAggregate(raw.cart);
    const quote = decodeConfiguredPriceQuoteSnapshot(
      encodeConfiguredPriceQuoteSnapshot(raw.quote as ConfiguredPriceQuoteSnapshot),
    );
    const observedAt = parseOrderingInstant(raw.observedAt);
    const channel = parsePricingCode(raw.pricingChannelCode);
    assertCartLifecycleActive(cart.lifecycle, observedAt);
    if (observedAt >= quote.expiresAt) throw new CartError("CART_QUOTE_EXPIRED");
    if (
      cart.updatedAt > quote.createdAt ||
      quote.createdAt > observedAt ||
      quote.brandReference !== String(cart.brandReference) ||
      quote.storeReference !== String(cart.storeReference) ||
      quote.cartReference !== String(cart.cartReference) ||
      quote.cartVersion !== cart.aggregateVersion ||
      quote.lines.length !== cart.items.length ||
      !Array.isArray(raw.catalogLines) ||
      raw.catalogLines.length !== cart.items.length
    )
      return invalid();
    const snapshots = new Map<
      ReturnType<typeof parseOrderingReference>,
      ReturnType<typeof parseOrderCatalogLineSnapshot>
    >();
    for (const value of raw.catalogLines) {
      const row = readClosedRecord(value, ["cartItemReference", "snapshot"]);
      const reference = parseOrderingReference(row.cartItemReference);
      if (snapshots.has(reference)) return invalid();
      snapshots.set(reference, parseOrderCatalogLineSnapshot(row.snapshot));
    }
    for (const item of cart.items) {
      const line = quote.lines.find(
        (candidate) => String(candidate.lineReference) === item.cartItemReference,
      );
      const catalog = snapshots.get(item.cartItemReference);
      const evidence = item.catalogSelectionEvidence;
      if (
        line === undefined ||
        catalog === undefined ||
        evidence === null ||
        line.sellableReference !== String(item.sellableReference) ||
        line.quantity !== item.quantity ||
        String(line.productVersionReference) !== evidence.productVersionReference ||
        String(line.menuVersionReference) !== evidence.menuVersionReference ||
        catalog.brandReference !== cart.brandReference ||
        catalog.storeReference !== cart.storeReference ||
        catalog.sellableReference !== item.sellableReference ||
        catalog.skuReference !== item.sellableReference ||
        catalog.productVersionReference !== evidence.productVersionReference ||
        catalog.menuVersionReference !== evidence.menuVersionReference ||
        catalog.capturedAt < quote.createdAt ||
        catalog.capturedAt > observedAt ||
        evidence.validatedAt > quote.createdAt ||
        catalog.options.length !== item.optionSelections.length ||
        line.optionPrices.length !== item.optionSelections.length ||
        line.taxResolution.rules.some(
          (rule) =>
            String(rule.resolvedRule.taxClassificationReference) !==
            catalog.taxClassificationReference,
        ) ||
        (line.resolvedPrice.orderType !== null &&
          line.resolvedPrice.orderType !== cart.orderType) ||
        (line.resolvedPrice.channelCode !== null && line.resolvedPrice.channelCode !== channel)
      )
        return invalid();
      const seen = new Set<string>();
      for (const selected of item.optionSelections) {
        const owners = catalog.options.filter(
          (option) => option.optionReference === selected.optionReference,
        );
        const prices = line.optionPrices.filter(
          (option) => String(option.rule.optionReference) === selected.optionReference,
        );
        const owner = owners[0],
          price = prices[0];
        if (
          owners.length !== 1 ||
          prices.length !== 1 ||
          owner === undefined ||
          price === undefined ||
          seen.has(String(price.rule.optionReference)) ||
          owner.quantity !== selected.quantity ||
          price.selectedQuantity !== selected.quantity ||
          price.itemQuantity !== item.quantity ||
          String(price.rule.bindingReference) !== owner.bindingReference ||
          price.context.orderType !== cart.orderType ||
          price.context.channelCode !== channel ||
          String(price.taxClassificationReference) !== catalog.taxClassificationReference ||
          !evidence.ruleEvidence.some(
            (rule) =>
              rule.bindingReference === owner.bindingReference &&
              rule.optionSetVersionReference === owner.optionSetVersionReference,
          )
        )
          return invalid();
        seen.add(String(price.rule.optionReference));
      }
    }
    return quote;
  } catch (error) {
    if (
      error instanceof CartError &&
      ["CART_QUOTE_EXPIRED", "CART_EXPIRED", "CART_ABANDONED"].includes(error.code)
    )
      throw error;
    return invalid();
  }
}
