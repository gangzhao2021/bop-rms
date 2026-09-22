import { allocateOrdinaryRefund } from "./ordinary-refund-allocation.js";
import type { PriceQuoteSnapshot } from "./price-quote.js";
import type { ConfiguredPriceQuoteSnapshot } from "./configured-price-quote.js";
import {
  encodePriceQuoteSnapshot,
  decodePriceQuoteSnapshot,
  encodeConfiguredPriceQuoteSnapshot,
  decodeConfiguredPriceQuoteSnapshot,
} from "./price-quote-snapshot-codec.js";
import { parsePricingReference } from "./money-tax-contract.js";
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_QUOTE_INVALID");
};
interface ItemMapping {
  readonly orderItemReference: string;
  readonly quoteLineReference: string;
  readonly quantity: number;
  readonly occupiedUnitOrdinals: readonly number[];
  readonly refundQuantity: number;
}
/** Use the original persisted quote, not a new quote at refund time.
 * The Order owner supplies complete immutable line-to-item mapping. */
export function allocateOrdinaryRefundFromQuote(
  value: PriceQuoteSnapshot | ConfiguredPriceQuoteSnapshot,
  input: { readonly tipAmountMinor: bigint; readonly items: readonly ItemMapping[] },
) {
  try {
    const version = Object.getOwnPropertyDescriptor(value, "quoteVersion");
    if (!version || !("value" in version) || (version.value !== 1 && version.value !== 2))
      return fail();
    const quote =
      version.value === 2
        ? decodeConfiguredPriceQuoteSnapshot(
            encodeConfiguredPriceQuoteSnapshot(value as ConfiguredPriceQuoteSnapshot),
          )
        : decodePriceQuoteSnapshot(encodePriceQuoteSnapshot(value as PriceQuoteSnapshot));
    if (
      quote.currencyMetadata.currencyCode !== "CAD" ||
      quote.blockingReasons.length !== 0 ||
      quote.fee.amountMinor !== 0n ||
      quote.lines.some((line) => line.fee.amountMinor !== 0n) ||
      !Array.isArray(input.items) ||
      input.items.length !== quote.lines.length
    )
      return fail();
    const mappings = new Map<string, ItemMapping>();
    for (const item of input.items) {
      const key = String(parsePricingReference(item.quoteLineReference));
      if (mappings.has(key)) return fail();
      mappings.set(key, item);
    }
    return allocateOrdinaryRefund({
      sourceReference: quote.quoteReference,
      sourceDigest: quote.inputDigest,
      currencyCode: "CAD",
      tipAmountMinor: input.tipAmountMinor,
      serviceChargeAmountMinor: 0n,
      serviceChargeTaxAmountMinor: 0n,
      items: quote.lines.map((line) => {
        const item = mappings.get(line.lineReference);
        if (!item || item.quantity !== line.quantity) return fail();
        return {
          orderItemReference: item.orderItemReference,
          quantity: line.quantity,
          netAmountMinor: line.subtotal.amountMinor - line.discount.amountMinor,
          taxAmountMinor: line.tax.amountMinor,
          occupiedUnitOrdinals: item.occupiedUnitOrdinals,
          refundQuantity: item.refundQuantity,
        };
      }),
    });
  } catch {
    return fail();
  }
}
