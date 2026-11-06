import type { ConsumerTransaction } from "@bop/eventing";
import {
  createMemberPointsStore,
  memberExpiryStep,
  memberPointsExpireAt,
  pointsForRefundedShare,
  type MemberPhoneProtector,
} from "@rms/customer-loyalty";
import {
  createPostgresDiningTableSettlementStore,
  createPostgresStoreSalesPaymentLedger,
} from "@rms/payment";
import { memberExpiryText, type MemberMessagePort } from "./customer-member.js";
import { storeOffersPoints } from "./merchant-store-features.js";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS: the background work of points, for one Store. It compares the
 * refunds on record with the ledger, so every way of refunding is covered without each calling
 * here, and running it twice changes nothing. Taking points back ignores the Store's switch; only
 * expiry stops when the Store's points are off, so a Brand with every Store off expires nothing.
 */
export const memberPointsSweepIntervalMs = 5 * 60_000;
const refundLookbackMs = 3 * 86_400_000;
/**
 * v15 2026-11-06 (points-sweep): how far a sweep catches up. A process's first sweep looks back this
 * far; after a run of failed sweeps, the next one reaches back to its last success (less the usual
 * three days), up to this far. Sweeping again changes nothing, so the overlap is harmless. A sweep
 * failing longer than this has been raised to a person for two weeks by then (the workload's
 * attention rule); older refunds are left to them.
 */
export const memberPointsCatchUpMs = 14 * 86_400_000;
const expiryBatch = 50;

export function createMemberPointsSweep(options: {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  };
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly protector: MemberPhoneProtector;
  readonly messages: MemberMessagePort | null;
  nextReference(): string;
  now(): string;
}) {
  const { scope } = options;
  const points = createMemberPointsStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    nextReference: options.nextReference,
    now: options.now,
    protector: options.protector,
  });
  const settlements = createPostgresDiningTableSettlementStore({
    scope,
    authorize: async () => true,
  });

  const settleOrder = async (
    tx: ConsumerTransaction,
    order: string,
    refunds: readonly { paymentIntentReference: string; amountMinor: bigint }[],
    paidMinor: bigint,
  ) => {
    const activity = await points.orderActivity(tx as never, order);
    if (activity.earned.length === 0 && activity.spent.length === 0) return 0;
    const refundedMinor = refunds.reduce((sum, refund) => sum + refund.amountMinor, 0n);
    const records = await settlements.listByOrders(tx as never, [order]);
    // A table's payments say what was paid; its ledger lines leave the cash rounding apart, and a
    // full refund must read as full.
    const billPaid =
      records.length > 0 ? records.reduce((sum, record) => sum + record.totalMinor, 0n) : paidMinor;
    let changed = 0;
    for (const earn of activity.earned) {
      if (!earn.open) continue;
      // A paid part answers for its own refunds; a whole bill for all of them.
      const settlement = records.find(
        (record) => record.settlementReference === earn.sourceReference,
      );
      const own =
        settlement === undefined
          ? []
          : refunds.filter(
              (refund) =>
                refund.paymentIntentReference.startsWith(settlement.settlementReference + ":") ||
                refund.paymentIntentReference === settlement.onlinePaymentReference,
            );
      const direct = settlement !== undefined && (own.length > 0 || activity.earned.length > 1);
      const refunded = direct ? own.reduce((sum, r) => sum + r.amountMinor, 0n) : refundedMinor;
      const paid = direct ? (settlement as (typeof records)[number]).totalMinor : billPaid;
      const owed = pointsForRefundedShare(earn.points, refunded, paid) - earn.reversedPoints;
      if (owed <= 0) continue;
      await points.reverseEarned(tx as never, {
        accountReference: earn.accountReference,
        earnReference: earn.transactionReference,
        orderReference: order,
        points: owed,
      });
      changed += 1;
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
      await points.returnRedeemed(tx as never, {
        accountReference: spent.accountReference,
        redemptionReference: spent.redemptionReference,
        orderReference: order,
        points: owed,
        reasonCode: writtenOff ? "BILL_WRITTEN_OFF" : "ORDER_REFUNDED",
      });
      changed += 1;
    }
    return changed;
  };

  // When this process's last sweep of refunds succeeded (its clock), or null before the first.
  let settledAt: number | null = null;
  return Object.freeze({
    /** Refunds and unpaid tables since a few days ago: the ledger catches up with them. */
    async settlePoints(): Promise<number> {
      const now = Date.parse(options.now());
      const lookbackMs =
        settledAt === null
          ? memberPointsCatchUpMs
          : Math.min(memberPointsCatchUpMs, Math.max(0, now - settledAt) + refundLookbackMs);
      const startsAt = new Date(now - lookbackMs).toISOString();
      const endsAt = new Date(now + 1000).toISOString();
      const changed = await options.transactions.run(async (tx) => {
        const ledger = await createPostgresStoreSalesPaymentLedger({
          scope,
          authorize: async () => true,
        })(tx, { startsAt, endsAt, observedAt: endsAt });
        const recent = await points.ordersWithPoints(tx as never, startsAt, 500);
        const orders = new Set([
          ...ledger.refunds.map((refund) => refund.orderReference),
          ...recent,
        ]);
        let changed = 0;
        for (const order of orders) {
          const paidMinor = [...ledger.payments, ...ledger.refundedPayments]
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
          changed += await settleOrder(
            tx,
            order,
            ledger.refunds.filter((refund) => refund.orderReference === order),
            paidMinor,
          );
        }
        return changed;
      });
      settledAt = now;
      return changed;
    },

    /**
     * Tell members before their points expire, then expire them. No way to text means no notice,
     * so no expiry either: a guest is never surprised.
     */
    async expirePoints(): Promise<{ readonly notified: number; readonly expired: number }> {
      const messages = options.messages;
      const due = await options.transactions.run(async (tx) => {
        if (!(await storeOffersPoints(tx as never, scope))) return null;
        const rule = await points.currentRule(tx as never);
        return Object.freeze({
          rule,
          candidates: await points.expiryCandidates(tx as never, rule, expiryBatch),
        });
      });
      if (due === null) return Object.freeze({ notified: 0, expired: 0 });
      let notified = 0,
        expired = 0;
      for (const candidate of due.candidates) {
        const step = memberExpiryStep({ ...candidate, now: options.now(), rule: due.rule });
        const expiresAt = memberPointsExpireAt(candidate.lastActivityAt, due.rule);
        if (step === "SendNotice" && messages !== null) {
          // Sent while holding the account, and recorded with it: a failed text records nothing,
          // and another Store's sweep waits, then sees it was told.
          const told = await options.transactions
            .run(async (tx) => {
              const phone = await points.claimExpiryNotice(tx as never, {
                accountReference: candidate.accountReference,
                lastActivityAt: candidate.lastActivityAt,
              });
              if (phone === null) return false;
              await messages.send({
                phone,
                kind: "ExpiryNotice",
                text: memberExpiryText(candidate.availablePoints, expiresAt.slice(0, 10)),
              });
              await points.recordExpiryNotice(tx as never, {
                accountReference: candidate.accountReference,
                lastActivityAt: candidate.lastActivityAt,
                expiresAt,
              });
              return true;
            })
            .catch(() => false);
          if (told) notified += 1;
        } else if (step === "Expire") {
          const result = await options.transactions.run((tx) =>
            points.expire(tx as never, {
              accountReference: candidate.accountReference,
              lastActivityAt: candidate.lastActivityAt,
            }),
          );
          if (result.points > 0) expired += 1;
        }
      }
      return Object.freeze({ notified, expired });
    },
  });
}
