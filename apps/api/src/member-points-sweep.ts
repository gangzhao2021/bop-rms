import type { ConsumerTransaction } from "@bop/eventing";
import {
  createMemberPointsStore,
  memberExpiryStep,
  memberPointsExpireAt,
  type MemberPhoneProtector,
} from "@rms/customer-loyalty";
import {
  createPostgresDiningTableSettlementStore,
  createPostgresStoreSalesPaymentLedger,
} from "@rms/payment";
import { memberExpiryText, type MemberMessagePort } from "./customer-member.js";
import {
  createMemberPointsOrderSettler,
  ledgerOrderPaidMinor,
} from "./member-points-refund-share.js";
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

  // v15 (M60): the one rule, shared with a claim made after a refund.
  const settleOrder = createMemberPointsOrderSettler({
    points,
    settlements,
  });

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
          const paidMinor = ledgerOrderPaidMinor(ledger, order);
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
