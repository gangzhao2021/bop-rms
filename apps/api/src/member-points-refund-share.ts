import type { ConsumerTransaction } from "@bop/eventing";
import { pointsForRefundedShare, type createMemberPointsStore } from "@rms/customer-loyalty";
import type { createPostgresDiningTableSettlementStore } from "@rms/payment";

/**
 * v15 (M60, M12): the one rule for how many earned points a refund takes back, shared by the
 * background sweep and the receipt's offer, so a guest is never offered points that the sweep
 * would take back a few minutes later, and a claim after a refund records the same reversal the
 * sweep would have recorded.
 */
export interface PointsRefund {
  readonly paymentIntentReference: string;
  readonly amountMinor: bigint;
}
export interface PointsSettlement {
  readonly settlementReference: string;
  readonly onlinePaymentReference: string | null;
  readonly totalMinor: bigint;
}

/**
 * For each earning of one Order, how many of its points its refunds take back in all. A paid part
 * of a split bill answers for the refunds keyed to it (or to its phone payment); a whole bill, a
 * pickup or a pay-first round answers for all of the Order's refunds, against everything paid.
 */
export function refundedPointsTargets(input: {
  readonly earned: readonly { readonly sourceReference: string; readonly points: number }[];
  readonly settlements: readonly PointsSettlement[];
  readonly refunds: readonly PointsRefund[];
  /** What the ledger says the Order paid; a table's settlements say it instead when there are any. */
  readonly paidMinor: bigint;
}): number[] {
  const refundedMinor = input.refunds.reduce((sum, refund) => sum + refund.amountMinor, 0n);
  // A table's payments say what was paid; its ledger lines leave the cash rounding apart, and a
  // full refund must read as full.
  const billPaid =
    input.settlements.length > 0
      ? input.settlements.reduce((sum, record) => sum + record.totalMinor, 0n)
      : input.paidMinor;
  return input.earned.map((earn) => {
    const settlement = input.settlements.find(
      (record) => record.settlementReference === earn.sourceReference,
    );
    const own =
      settlement === undefined
        ? []
        : input.refunds.filter(
            (refund) =>
              refund.paymentIntentReference.startsWith(settlement.settlementReference + ":") ||
              refund.paymentIntentReference === settlement.onlinePaymentReference,
          );
    const direct = settlement !== undefined && (own.length > 0 || input.earned.length > 1);
    const refunded = direct ? own.reduce((sum, r) => sum + r.amountMinor, 0n) : refundedMinor;
    const paid = direct ? (settlement as PointsSettlement).totalMinor : billPaid;
    return pointsForRefundedShare(earn.points, refunded, paid);
  });
}

/** What the ledger says an Order paid: each payment once, whether or not it was refunded since. */
export function ledgerOrderPaidMinor(
  ledger: {
    readonly payments: readonly LedgerPayment[];
    readonly refundedPayments: readonly LedgerPayment[];
  },
  order: string,
): bigint {
  return [...ledger.payments, ...ledger.refundedPayments]
    .filter((payment, index, all) => {
      if (payment.orderReference !== order) return false;
      // A payment seen in both lists counts once.
      return (
        all.findIndex(
          (other) =>
            other.paymentIntentReference === payment.paymentIntentReference &&
            other.orderBatchReference === payment.orderBatchReference,
        ) === index
      );
    })
    .reduce((sum, payment) => sum + payment.totalMinor, 0n);
}
interface LedgerPayment {
  readonly orderReference: string;
  readonly paymentIntentReference: string;
  readonly orderBatchReference: string;
  readonly totalMinor: bigint;
}

/**
 * Record what one Order's refunds take back of its points, and give back points spent on it. The
 * sweep and a claim after a refund both call this, possibly at the same moment. Each reversal and
 * return posts only what is still missing once the member's account is held (the one lock every
 * points write takes), so two runs reading at once never take the same points back twice. No
 * Order-level lock: the sweep holds several accounts in one transaction, and a second lock kind
 * taken in another order could deadlock with a claim.
 */
export function createMemberPointsOrderSettler(dependencies: {
  readonly points: ReturnType<typeof createMemberPointsStore>;
  readonly settlements: ReturnType<typeof createPostgresDiningTableSettlementStore>;
}) {
  const { points, settlements } = dependencies;
  return async (
    tx: ConsumerTransaction,
    order: string,
    refunds: readonly PointsRefund[],
    paidMinor: bigint,
  ): Promise<number> => {
    const activity = await points.orderActivity(tx as never, order);
    if (activity.earned.length === 0 && activity.spent.length === 0) return 0;
    const refundedMinor = refunds.reduce((sum, refund) => sum + refund.amountMinor, 0n);
    const records = await settlements.listByOrders(tx as never, [order]);
    const billPaid =
      records.length > 0 ? records.reduce((sum, record) => sum + record.totalMinor, 0n) : paidMinor;
    const targets = refundedPointsTargets({
      earned: activity.earned,
      settlements: records,
      refunds,
      paidMinor,
    });
    let changed = 0;
    for (const [index, earn] of activity.earned.entries()) {
      if (!earn.open) continue;
      const owed = (targets[index] ?? 0) - earn.reversedPoints;
      if (owed <= 0) continue;
      const posted = await points.reverseEarned(tx as never, {
        accountReference: earn.accountReference,
        earnReference: earn.transactionReference,
        orderReference: order,
        points: owed,
        seenReversedPoints: earn.reversedPoints,
      });
      if (posted > 0) changed += 1;
    }
    const writtenOff =
      records.length === 0 &&
      (await settlements.listWriteOffsByOrders(tx as never, [order])).length > 0;
    for (const spent of activity.spent) {
      if (!spent.open) continue;
      const share = writtenOff
        ? spent.points
        : pointsForRefundedShare(spent.points, refundedMinor, billPaid);
      const owed = share - spent.returnedPoints;
      if (owed <= 0) continue;
      const posted = await points.returnRedeemed(tx as never, {
        accountReference: spent.accountReference,
        redemptionReference: spent.redemptionReference,
        orderReference: order,
        points: owed,
        reasonCode: writtenOff ? "BILL_WRITTEN_OFF" : "ORDER_REFUNDED",
        seenReturnedPoints: spent.returnedPoints,
      });
      if (posted > 0) changed += 1;
    }
    return changed;
  };
}
