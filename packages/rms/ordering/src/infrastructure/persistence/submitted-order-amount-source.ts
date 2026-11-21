import { createHash } from "node:crypto";
import { createPostgresReceiptOrderSource } from "./receipt-order-source.js";
import { parseReceiptOrderSnapshot } from "../../domain/receipt-order-snapshot.js";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
const fail = (): never => {
  throw new Error("SUBMITTED_ORDER_AMOUNT_UNAVAILABLE");
};
/** Complete submitted line-price basis, excluding tips. Not a current receivable:
 * callers must separately resolve applied amendments/cancellations and finality.
 * Uses frozen transaction prices, never current menu prices or payment totals. */
export function createPostgresSubmittedOrderAmountSource(
  options: Parameters<typeof createPostgresReceiptOrderSource>[0],
) {
  const brandReference = String(parseOrderingReference(options.brandReference)),
    storeReference = String(parseOrderingReference(options.storeReference));
  const read = createPostgresReceiptOrderSource({ ...options, brandReference, storeReference });
  return async (...args: Parameters<typeof read>) => {
    try {
      const [tx, input] = args,
        orderReference = String(parseOrderingReference(input.orderReference)),
        observedAt = String(parseOrderingInstant(input.observedAt));
      const order = parseReceiptOrderSnapshot(await read(tx, { orderReference, observedAt }));
      if (
        String(order.brandReference) !== brandReference ||
        String(order.storeReference) !== storeReference ||
        String(order.orderReference) !== orderReference ||
        order.createdAt > observedAt ||
        order.batches.some((batch) => batch.submittedAt > observedAt)
      )
        return fail();
      const fields = ["subtotal", "discount", "fee", "tax", "total"] as const;
      const amounts = () => ({
        subtotalMinor: 0n,
        discountMinor: 0n,
        feeMinor: 0n,
        taxMinor: 0n,
        totalMinor: 0n,
      });
      const total = amounts();
      const batches = order.batches.map((batch) => {
        const result = amounts();
        const items = order.items.filter(
          (item) => item.snapshot.orderBatchReference === batch.orderBatchReference,
        );
        for (const { snapshot } of items)
          for (const field of fields) {
            const money = snapshot.pricing[field];
            if (money.currencyCode !== "CAD" || money.amountMinor < 0n) return fail();
            const key = `${field}Minor` as keyof typeof result;
            result[key] += money.amountMinor;
            total[key] += money.amountMinor;
            if (total[key] > 9223372036854775807n) return fail();
          }
        return Object.freeze({
          orderBatchReference: batch.orderBatchReference,
          itemCount: items.length,
          ...result,
        });
      });
      const snapshotDigest =
        "sha256:" +
        createHash("sha256")
          .update(
            JSON.stringify([
              brandReference,
              storeReference,
              orderReference,
              order.items.map(({ snapshot }) => [
                snapshot.orderItemReference,
                snapshot.orderBatchReference,
                snapshot.pricing.quoteInputDigest,
                ...fields.map((field) => snapshot.pricing[field].amountMinor.toString()),
              ]),
            ]),
          )
          .digest("hex");
      return Object.freeze({
        brandReference,
        storeReference,
        orderReference,
        observedAt,
        currencyCode: "CAD" as const,
        basis: "SubmittedItemSnapshots" as const,
        tipIncluded: false as const,
        amendmentAdjustmentsIncluded: false as const,
        ...total,
        batches: Object.freeze(batches),
        snapshotDigest,
      });
    } catch {
      return fail();
    }
  };
}
