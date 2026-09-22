import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresDiningCheckoutCommitmentStore,
  parseDiningCheckoutCommitment,
} from "@rms/dining";
import {
  parseCheckoutSessionAllocation,
  parseOrderingInstant,
  parseOrderingReference,
} from "@rms/ordering";
import { createCheckoutAllocationPaymentObservation } from "./checkout-allocation-payment-observation.js";
const unavailable = (): never => {
  throw new Error("DINING_CHECKOUT_TIMEOUT_OBSERVATION_UNAVAILABLE");
};

/** Read-only evidence for a later fenced, per-Batch disposition. Neither a missing
 * Payment record nor a deadline authorizes cancellation, stock release or refund.
 */
export function createDiningCheckoutTimeoutObservation(options: {
  scope: Parameters<typeof createCheckoutAllocationPaymentObservation>[0]["scope"] & {
    tenantReference: string;
  };
  now(): string;
  authorize(transaction: ConsumerTransaction): Promise<boolean>;
}) {
  const scope = Object.freeze({
    ...options.scope,
    tenantReference: String(parseOrderingReference(options.scope.tenantReference)),
  });
  const paymentSource = createCheckoutAllocationPaymentObservation({ ...options, scope });
  return Object.freeze({
    async resolve(transaction: ConsumerTransaction, value: unknown) {
      try {
        const allocation = parseCheckoutSessionAllocation(value);
        const started = parseOrderingInstant(options.now());
        if (
          allocation.brandReference !== scope.brandReference ||
          allocation.storeReference !== scope.storeReference ||
          allocation.allocatedAt > started ||
          !(await options.authorize(transaction))
        )
          return unavailable();
        const owner = createPostgresDiningCheckoutCommitmentStore(
          { run: (work) => work(transaction) },
          {
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
          },
          { now: options.now },
        );
        const clock = parseDiningCheckoutCommitment(
          await owner.loadSubmission(allocation.submissionReference),
        );
        if (
          clock.brandReference !== scope.brandReference ||
          clock.storeReference !== scope.storeReference ||
          clock.submissionReference !== allocation.submissionReference ||
          clock.paymentOperationReference !== allocation.paymentOperationReference ||
          clock.cartReference !== allocation.cartReference ||
          clock.cartVersion !== allocation.cartVersion ||
          clock.quoteReference !== allocation.quoteReference ||
          clock.guestSessionReference !== allocation.guestSessionReference
        )
          return unavailable();
        const finish = async () => {
          const at = parseOrderingInstant(options.now());
          if (at < started || !(await options.authorize(transaction))) return unavailable();
          return at;
        };
        if (clock.paymentRequestedAt === null) {
          return Object.freeze({
            commitmentReference: clock.commitmentReference,
            orderReference: clock.orderReference,
            orderBatchReference: clock.orderBatchReference,
            submissionReference: clock.submissionReference,
            paymentOperationReference: clock.paymentOperationReference,
            observedAt: await finish(),
            status: "NotStarted" as const,
          });
        }
        if (
          clock.capacityExpiresAt === null ||
          clock.orderingLinkedAt === null ||
          String(clock.paymentRequestedAt) > String(started)
        )
          return unavailable();
        const identity = {
          commitmentReference: clock.commitmentReference,
          orderReference: clock.orderReference,
          orderBatchReference: clock.orderBatchReference,
          submissionReference: clock.submissionReference,
          paymentOperationReference: clock.paymentOperationReference,
          capacityExpiresAt: clock.capacityExpiresAt,
          paymentRequestedAt: clock.paymentRequestedAt,
        };
        const checkedAt = await finish();
        if (String(checkedAt) < String(clock.capacityExpiresAt))
          return Object.freeze({ ...identity, observedAt: checkedAt, status: "NotDue" as const });
        const payment = await paymentSource.resolve(transaction, allocation);
        const observedAt = await finish();
        if (payment.status === "Unresolved")
          return Object.freeze({
            ...identity,
            observedAt,
            status: "Unresolved" as const,
            reason: payment.reason,
          });
        const preparation = payment.payment.intent.preparation;
        if (
          String(preparation.orderReference) !== String(clock.orderReference) ||
          String(preparation.orderBatchReference) !== String(clock.orderBatchReference) ||
          String(preparation.capacityAllocationReference) !== String(clock.commitmentReference) ||
          String(preparation.capacityExpiresAt) !== String(clock.capacityExpiresAt) ||
          String(preparation.committedAt) !== String(clock.paymentRequestedAt)
        )
          return unavailable();
        return Object.freeze({
          ...identity,
          observedAt,
          status:
            payment.outcome === "Failed"
              ? ("Failed" as const)
              : String(payment.terminal.occurredAt) < String(clock.capacityExpiresAt)
                ? ("PaidBeforeDeadline" as const)
                : ("PaidAtOrAfterDeadline" as const),
          paymentIntentReference: payment.payment.intent.paymentIntentReference,
          paymentAttemptReference: payment.payment.attempt.paymentAttemptReference,
          terminalOccurredAt: payment.terminal.occurredAt,
          paymentEventReference: parseOrderingReference(payment.terminal.event.eventId),
        });
      } catch {
        return unavailable();
      }
    },
  });
}
