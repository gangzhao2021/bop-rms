import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderRefundBasisReader } from "@rms/ordering";
import {
  createPostgresPriceQuoteHistoryReader,
  createPostgresConfiguredPriceQuoteHistoryReader,
  allocateOrdinaryRefundFromQuote,
} from "@rms/pricing";
import type { createPostgresOrdinaryRefundCaptureSource } from "./persistence/ordinary-refund-capture-source.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
type CaptureOptions = Parameters<typeof createPostgresOrdinaryRefundCaptureSource>[0];
type PricingValidator = CaptureOptions["validatePricing"];
const components = [
  "netAmountMinor",
  "taxAmountMinor",
  "tipAmountMinor",
  "serviceChargeAmountMinor",
  "serviceChargeTaxAmountMinor",
] as const;

/** Compose owner public immutable readers; no private SQL or current repricing.
 * Payment request writer supplies the complete held-fence ordinary history. */
export function createPostgresOrdinaryRefundPricingSource(options: {
  readonly scope: Pick<
    CaptureOptions["scope"],
    "tenantReference" | "brandReference" | "storeReference"
  >;
  readonly authorize: CaptureOptions["authorize"];
}): PricingValidator {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx, { request, payment, preparation, history }) => {
    if (
      request.tenantReference !== scope.tenantReference ||
      request.brandReference !== scope.brandReference ||
      request.storeReference !== scope.storeReference ||
      preparation.orderReference !== request.orderReference ||
      String(preparation.brandReference) !== scope.brandReference ||
      String(preparation.storeReference) !== scope.storeReference ||
      (await options.authorize(tx, request)) !== true
    )
      return false;
    const basis = await createPostgresOrderRefundBasisReader({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize: (transaction) => options.authorize(transaction, request),
    }).load(tx, {
      orderReference: request.orderReference,
      orderBatchReference: preparation.orderBatchReference,
      submissionReference: preparation.submissionReference,
      quoteReference: preparation.quoteReference,
      observedAt: request.requestedAt,
    });
    const runner = {
      run: async <T>(work: (transaction: ConsumerTransaction) => Promise<T>) => work(tx),
    };
    const quoteScope = {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    };
    const quote = await (
      basis.quoteVersion === 2
        ? createPostgresConfiguredPriceQuoteHistoryReader(runner, quoteScope)
        : createPostgresPriceQuoteHistoryReader(runner, quoteScope)
    ).load(preparation.quoteReference);
    if (
      !quote ||
      quote.cartReference !== basis.cartReference ||
      quote.cartVersion !== basis.cartVersion ||
      quote.inputDigest !== basis.quoteInputDigest ||
      quote.total.amountMinor !== preparation.orderAllocation.amountMinor ||
      quote.createdAt > preparation.committedAt ||
      Date.parse(preparation.committedAt) > Date.parse(request.requestedAt) ||
      quote.lines.length !== basis.items.length
    )
      return false;
    const requested = new Map(payment.items.map((item) => [item.orderItemReference, item]));
    if (
      payment.items.some(
        (item) =>
          !basis.items.some((source) => source.orderItemReference === item.orderItemReference),
      )
    )
      return false;
    const mapping = [];
    for (const item of basis.items) {
      const line = quote.lines.find(
        (entry) => String(entry.lineReference) === item.quoteLineReference,
      );
      if (
        !line ||
        line.quantity !== item.quantity ||
        line.subtotal.amountMinor !== item.subtotalMinor ||
        line.discount.amountMinor !== item.discountMinor ||
        line.tax.amountMinor !== item.taxMinor ||
        line.fee.amountMinor !== item.feeMinor ||
        line.total.amountMinor !== item.totalMinor
      )
        return false;
      const occupied = history.flatMap((prior) =>
        prior.payments.flatMap((leg) =>
          leg.items
            .filter((old) => old.orderItemReference === item.orderItemReference)
            .flatMap((old) => old.refundUnitOrdinals),
        ),
      );
      mapping.push({
        orderItemReference: item.orderItemReference,
        quoteLineReference: item.quoteLineReference,
        quantity: item.quantity,
        occupiedUnitOrdinals: occupied,
        refundQuantity: requested.get(item.orderItemReference)?.refundUnitOrdinals.length ?? 0,
      });
    }
    const allocation = allocateOrdinaryRefundFromQuote(quote, {
      tipAmountMinor: preparation.tip.amountMinor,
      items: mapping,
    });
    if (
      allocation.sourceReference !== payment.sourceReference ||
      allocation.sourceDigest !== payment.sourceDigest
    )
      return false;
    const selected = allocation.items.filter((item) => item.refundQuantity > 0);
    if (selected.length !== payment.items.length) return false;
    for (const expected of selected) {
      const actual = requested.get(expected.orderItemReference);
      if (
        !actual ||
        actual.refundUnitOrdinals.join(",") !== expected.refundUnitOrdinals.join(",") ||
        components.some((key) => actual.components[key] !== expected.components[key])
      )
        return false;
    }
    return (await options.authorize(tx, request)) === true;
  };
}
