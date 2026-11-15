/** The Orders list's figure for an unpaid pay-at-end table's bill (DEC-TAX-WHOLE-RECEIPT). */
import { computeBillTaxRounding, type BillTaxRoundingItem } from "@rms/ordering";

/** One dish as its price was recorded (listOrderItemPrices). */
export interface OrderBillPrice {
  readonly orderItemReference: unknown;
  readonly orderBatchReference: unknown;
  readonly subtotal: { readonly amountMinor: bigint };
  readonly discountMinor: bigint;
  readonly total: { readonly amountMinor: bigint };
  readonly taxComponents: BillTaxRoundingItem["taxComponents"];
}
/** A comp, discount or points redemption on a dish. */
export interface OrderBillReduction {
  readonly totalMinor: bigint;
  readonly netMinor: bigint;
  readonly taxMinor: bigint;
  readonly taxRoundingMinor: bigint;
}

/**
 * Owner 2026-11-03 walkthrough: what the Order's rounds on the table's bill come to, its tax worked
 * out once over the whole bill, after comps; `prices` are the dishes on it.
 */
export function orderBillOwedMinor(
  orderReference: string,
  rounds: readonly string[],
  prices: readonly OrderBillPrice[],
  reduced: ReadonlyMap<string, OrderBillReduction>,
): bigint {
  return (
    prices.reduce(
      (sum, price) =>
        sum +
        price.total.amountMinor -
        (reduced.get(String(price.orderItemReference))?.totalMinor ?? 0n),
      0n,
    ) +
    computeBillTaxRounding(
      rounds.map((batch) => ({
        orderReference,
        orderBatchReference: batch,
        items: prices
          .filter((price) => String(price.orderBatchReference) === batch)
          .map((price) => {
            const reduction = reduced.get(String(price.orderItemReference));
            return {
              orderItemReference: String(price.orderItemReference),
              netMinor: price.subtotal.amountMinor - price.discountMinor,
              taxComponents: price.taxComponents,
              reduction:
                reduction === undefined
                  ? null
                  : {
                      netMinor: reduction.netMinor,
                      taxMinor: reduction.taxMinor,
                      taxRoundingMinor: reduction.taxRoundingMinor,
                    },
            };
          }),
      })),
      { carrierOrderReference: orderReference },
    ).lines.reduce((sum, line) => sum + line.amountMinor, 0n)
  );
}

/**
 * v15 b19 (DEC-TAX-WHOLE-RECEIPT): the bill now, and what the dishes taken off it took off: the
 * bill with them less the bill now, so it equals the bill they were on to the cent (their own
 * prices added up can be a cent off it). `removedMinor` is null when none was taken off.
 */
export function orderBillWithRemoved(
  orderReference: string,
  rounds: readonly string[],
  prices: readonly OrderBillPrice[],
  reduced: ReadonlyMap<string, OrderBillReduction>,
  removed: ReadonlySet<string>,
): { readonly owedMinor: bigint; readonly removedMinor: bigint | null } {
  const kept = prices.filter((price) => !removed.has(String(price.orderItemReference)));
  const owedMinor = orderBillOwedMinor(orderReference, rounds, kept, reduced);
  return Object.freeze({
    owedMinor,
    removedMinor:
      kept.length === prices.length
        ? null
        : orderBillOwedMinor(orderReference, rounds, prices, reduced) - owedMinor,
  });
}
