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

/** A round on a bill: the Order it is on (a merged bill has several) and the round. */
export interface OrderBillRoundOf {
  readonly orderReference: string;
  readonly orderBatchReference: string;
}

/**
 * What a bill's rounds come to, its tax worked out once over the whole bill, after comps;
 * `prices` are the dishes on it and `carrierOrderReference` the Order holding the bill.
 */
export function billOwedMinor(
  carrierOrderReference: string,
  rounds: readonly OrderBillRoundOf[],
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
      rounds.map((round) => ({
        orderReference: round.orderReference,
        orderBatchReference: round.orderBatchReference,
        items: prices
          .filter((price) => String(price.orderBatchReference) === round.orderBatchReference)
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
      { carrierOrderReference },
    ).lines.reduce((sum, line) => sum + line.amountMinor, 0n)
  );
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
  return billOwedMinor(
    orderReference,
    rounds.map((orderBatchReference) => ({ orderReference, orderBatchReference })),
    prices,
    reduced,
  );
}

/**
 * v15 b19 (DEC-TAX-WHOLE-RECEIPT): on a bill of several Orders (tables merged into one), what one
 * Order's dishes taken off it took off, to the cent of the merged bill. The Orders are taken in the
 * bill's order (`removedByOrder`: each Order's dishes taken off): each Order's share is what the
 * bill went down by when its dishes came off after the earlier Orders', so the shares add up to
 * what the bill went down by in all. Null when the Order had none taken off.
 */
export function billRemovedMinor(
  carrierOrderReference: string,
  rounds: readonly OrderBillRoundOf[],
  prices: readonly OrderBillPrice[],
  reduced: ReadonlyMap<string, OrderBillReduction>,
  removedByOrder: readonly (readonly [string, ReadonlySet<string>])[],
  orderReference: string,
): bigint | null {
  const at = removedByOrder.findIndex(([order]) => order === orderReference);
  const here = removedByOrder[at]?.[1];
  if (here === undefined || !prices.some((price) => here.has(String(price.orderItemReference))))
    return null;
  const before = new Set(removedByOrder.slice(0, at).flatMap(([, lines]) => [...lines]));
  const kept = (off: ReadonlySet<string>) =>
    prices.filter((price) => !off.has(String(price.orderItemReference)));
  return (
    billOwedMinor(carrierOrderReference, rounds, kept(before), reduced) -
    billOwedMinor(carrierOrderReference, rounds, kept(new Set([...before, ...here])), reduced)
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
