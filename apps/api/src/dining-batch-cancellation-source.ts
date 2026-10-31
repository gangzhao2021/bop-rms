import type { ConsumerTransaction } from "@bop/eventing";
import { canonicalizeRfc8785 } from "@bop/audit";
import { createPostgresPaymentOperationFence } from "@rms/payment";
import {
  createPostgresDiningCheckoutCommitmentStore,
  parseDiningCheckoutCommitment,
} from "@rms/dining";
import {
  createPostgresOrderBatchCheckoutExpiryStore,
  diningCheckoutPaymentWindowMinutes,
  loadDiningBatchPaymentWindowStart,
  loadDiningRoundPaymentIdentity,
  parseOrderBatchCheckoutExpiry,
  parseOrderingReference,
  parseOrderingInstant,
} from "@rms/ordering";
import { createDiningOrderDeliveryProgress } from "./dining-order-delivery-progress.js";
type ProgressOptions = Parameters<typeof createDiningOrderDeliveryProgress>[0];
const unavailable = (): never => {
  throw new Error("DINING_BATCH_CANCELLATION_SOURCE_UNAVAILABLE");
};
/** Caller retains the transaction through policy, cancellation/revision and Audit. */
export function createDiningBatchCancellationSource(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  now(): string;
  authorize(
    tx: ConsumerTransaction,
    identity: { orderReference: string; orderBatchReference: string },
  ): Promise<boolean>;
  authorizeKitchen: ProgressOptions["authorizeKitchen"];
  authorizeDining: ProgressOptions["authorizeDining"];
}) {
  const scope = {
    tenantReference: parseOrderingReference(options.scope.tenantReference),
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  };
  return Object.freeze({
    /**
     * WP-2423 abandoned payment: the same evidence for a manager's cancellation of an unpaid round
     * before its deadline. No expiry evidence exists yet: the round's submission, Dining commitment
     * and payment operation come from Ordering's own records, under the payment operation fence.
     * Null when the round is not a Dining-owned round of this Order.
     */
    async loadForStaff(
      transaction: ConsumerTransaction,
      identity: { orderReference: string; orderBatchReference: string },
    ) {
      try {
        const at = parseOrderingInstant(options.now());
        const allowed = async (tx: unknown) =>
          tx === transaction && (await options.authorize(transaction, identity));
        if (!(await allowed(transaction))) return unavailable();
        const round = await loadDiningRoundPaymentIdentity(transaction, scope, identity);
        if (round === null) return null;
        await createPostgresPaymentOperationFence({
          ...scope,
          now: options.now,
          authorize: async (tx, query) =>
            query.orderReference === identity.orderReference &&
            query.paymentOperationReference === round.paymentOperationReference &&
            (await allowed(tx)),
        }).acquire(transaction, {
          orderReference: identity.orderReference,
          paymentOperationReference: round.paymentOperationReference,
        });
        const clock = parseDiningCheckoutCommitment(
          await createPostgresDiningCheckoutCommitmentStore(
            { run: (work) => work(transaction) },
            scope,
            { now: options.now },
          ).loadSubmission(round.submissionReference),
        );
        if (
          String(clock.brandReference) !== scope.brandReference ||
          String(clock.storeReference) !== scope.storeReference ||
          String(clock.orderReference) !== identity.orderReference ||
          String(clock.orderBatchReference) !== identity.orderBatchReference ||
          String(clock.submissionReference) !== round.submissionReference ||
          String(clock.paymentOperationReference) !== round.paymentOperationReference ||
          String(clock.commitmentReference) !== round.commitmentReference
        )
          return unavailable();
        const progress = await createDiningOrderDeliveryProgress({
          ...scope,
          diningScope: scope,
          authorize: allowed,
          authorizeKitchen: options.authorizeKitchen,
          authorizeDining: options.authorizeDining,
        }).load({
          transaction,
          ...scope,
          orderReference: identity.orderReference,
          diningSessionReference: clock.diningSessionReference,
          guestSessionReference: clock.guestSessionReference,
          observedAt: at,
        });
        if (
          !progress ||
          !progress.kitchenEvidenceComplete ||
          progress.orderReference !== identity.orderReference ||
          progress.brandReference !== scope.brandReference ||
          progress.storeReference !== scope.storeReference ||
          !progress.items.some(
            (item) => item.orderBatchReference === identity.orderBatchReference,
          ) ||
          parseOrderingInstant(options.now()) < at ||
          !(await allowed(transaction))
        )
          return unavailable();
        return Object.freeze({
          expiry: null,
          round: Object.freeze({ ...identity, ...round }),
          items: progress.items,
          orderVersion: progress.orderVersion,
          checkpoint: parseOrderingReference(progress.orderCheckpoint),
          progress,
          observedAt: at,
        });
      } catch {
        return unavailable();
      }
    },
    async load(transaction: ConsumerTransaction, value: unknown) {
      try {
        const expiry = parseOrderBatchCheckoutExpiry(value),
          at = parseOrderingInstant(options.now());
        const allowed = async (tx: unknown) =>
          tx === transaction && (await options.authorize(transaction, expiry));
        if (
          (expiry.status !== "PaymentFailed" && expiry.status !== "AwaitingPaymentResolution") ||
          expiry.tenantReference !== scope.tenantReference ||
          expiry.brandReference !== scope.brandReference ||
          expiry.storeReference !== scope.storeReference ||
          expiry.observedAt > at ||
          !(await allowed(transaction))
        )
          return unavailable();
        await createPostgresPaymentOperationFence({
          ...scope,
          now: options.now,
          authorize: async (tx, query) =>
            query.orderReference === expiry.orderReference &&
            query.paymentOperationReference === expiry.paymentOperationReference &&
            (await allowed(tx)),
        }).acquire(transaction, {
          orderReference: expiry.orderReference,
          paymentOperationReference: expiry.paymentOperationReference,
        });
        const history = await createPostgresOrderBatchCheckoutExpiryStore({
          ...scope,
          now: options.now,
          authorize: allowed,
          fence: async () => false,
          evidence: async () => unavailable(),
          audit: async () => unavailable(),
        }).load(transaction, {
          orderReference: expiry.orderReference,
          orderBatchReference: expiry.orderBatchReference,
        });
        if (canonicalizeRfc8785(history.at(-1) ?? null) !== canonicalizeRfc8785(expiry))
          return unavailable();
        const clock = parseDiningCheckoutCommitment(
          await createPostgresDiningCheckoutCommitmentStore(
            { run: (work) => work(transaction) },
            scope,
            { now: options.now },
          ).loadSubmission(expiry.submissionReference),
        );
        for (const key of [
          "brandReference",
          "storeReference",
          "orderReference",
          "orderBatchReference",
          "submissionReference",
          "paymentOperationReference",
          "commitmentReference",
        ] as const)
          if (String(clock[key]) !== String(expiry[key])) return unavailable();
        if (clock.paymentRequestedAt === null) {
          // WP-2423 item 3: the commitment never requested payment and no longer can; its window
          // started when the round was submitted (Ordering's record), which the expiry must state.
          const windowStartsAt = await loadDiningBatchPaymentWindowStart(transaction, scope, {
            orderReference: expiry.orderReference,
            orderBatchReference: expiry.orderBatchReference,
            submissionReference: expiry.submissionReference,
            commitmentReference: expiry.commitmentReference,
            paymentOperationReference: expiry.paymentOperationReference,
          });
          if (
            expiry.status !== "AwaitingPaymentResolution" ||
            clock.capacityExpiresAt !== null ||
            String(clock.preparationValidUntil) > String(expiry.observedAt) ||
            windowStartsAt === null ||
            expiry.paymentRequestedAt !== windowStartsAt ||
            expiry.capacityExpiresAt !==
              new Date(
                Date.parse(windowStartsAt) + diningCheckoutPaymentWindowMinutes * 60_000,
              ).toISOString() ||
            !(await allowed(transaction))
          )
            return unavailable();
        } else
          for (const key of ["paymentRequestedAt", "capacityExpiresAt"] as const)
            if (String(clock[key]) !== String(expiry[key])) return unavailable();
        const progress = await createDiningOrderDeliveryProgress({
          ...scope,
          diningScope: scope,
          authorize: allowed,
          authorizeKitchen: options.authorizeKitchen,
          authorizeDining: options.authorizeDining,
        }).load({
          transaction,
          ...scope,
          orderReference: expiry.orderReference,
          diningSessionReference: clock.diningSessionReference,
          guestSessionReference: clock.guestSessionReference,
          observedAt: at,
        });
        if (
          !progress ||
          !progress.kitchenEvidenceComplete ||
          progress.orderReference !== expiry.orderReference ||
          progress.brandReference !== scope.brandReference ||
          progress.storeReference !== scope.storeReference ||
          !progress.items.some((item) => item.orderBatchReference === expiry.orderBatchReference) ||
          parseOrderingInstant(options.now()) < at ||
          !(await allowed(transaction))
        )
          return unavailable();
        return Object.freeze({
          expiry,
          items: progress.items,
          orderVersion: progress.orderVersion,
          checkpoint: parseOrderingReference(progress.orderCheckpoint),
          progress,
          observedAt: at,
        });
      } catch {
        return unavailable();
      }
    },
  });
}
