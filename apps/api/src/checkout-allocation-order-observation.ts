import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderPaymentDispositionReader,
  parseOrderingInstant,
  parseOrderingReference,
} from "@rms/ordering";
import { createCheckoutAllocationPaymentObservation } from "./checkout-allocation-payment-observation.js";
const unavailable = (): never => {
  throw new Error("CHECKOUT_ORDER_OBSERVATION_UNAVAILABLE");
};
/** Immutable historical processing result. This is not current Dining/Cart
 * authority, refund clearance or a replacement command. No Order lock is taken
 * after the caller's Cart lock; confirmed history cannot change beneath this read.
 */
export function createCheckoutAllocationOrderObservation(
  options: Parameters<typeof createCheckoutAllocationPaymentObservation>[0],
) {
  const paymentSource = createCheckoutAllocationPaymentObservation(options);
  const reader = createPostgresOrderPaymentDispositionReader({
    brandReference: options.scope.brandReference,
    storeReference: options.scope.storeReference,
  });
  return Object.freeze({
    async resolve(transaction: ConsumerTransaction, allocation: unknown) {
      try {
        const started = parseOrderingInstant(options.now());
        const payment = await paymentSource.resolve(transaction, allocation);
        if (payment.status === "Unresolved") return payment;
        if (payment.outcome !== "Succeeded")
          return Object.freeze({
            status: "Unresolved" as const,
            reason: "FailedPaymentRequiresRecovery" as const,
          });
        const effect = await reader.loadByPaymentEvent({
          transaction,
          paymentEventReference: parseOrderingReference(payment.terminal.event.eventId),
        });
        const at = parseOrderingInstant(options.now());
        if (at < started || (await options.authorize(transaction)) !== true) return unavailable();
        if (effect === null)
          return Object.freeze({
            status: "Unresolved" as const,
            reason: "AwaitingOrderProcessing" as const,
          });
        const record = effect.record,
          p = payment.payment.intent.preparation,
          terminal = payment.terminal;
        if (
          !("disposition" in record) ||
          record.brandReference !== p.brandReference ||
          record.storeReference !== p.storeReference ||
          record.orderReference !== p.orderReference ||
          record.orderBatchReference !== p.orderBatchReference ||
          record.submissionReference !== p.submissionReference ||
          String(record.paymentIntentReference) !== String(terminal.paymentIntentReference) ||
          String(record.paymentAttemptReference) !== String(terminal.paymentAttemptReference) ||
          String(record.paymentTransactionReference) !==
            String(terminal.paymentTransactionReference) ||
          String(record.paymentEventReference) !== String(terminal.event.eventId) ||
          record.evaluatedAt > at
        )
          return unavailable();
        if (record.disposition !== "Confirmed")
          return Object.freeze({
            status: "Unresolved" as const,
            reason: "PaymentCompensationRequired" as const,
          });
        if (record.confirmedAt > at || effect.orderConfirmedEvent === null) return unavailable();
        return Object.freeze({ status: "Confirmed" as const, payment, orderEffect: effect });
      } catch {
        return unavailable();
      }
    },
  });
}
