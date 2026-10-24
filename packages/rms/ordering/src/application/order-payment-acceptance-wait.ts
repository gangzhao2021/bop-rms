import {
  parsePaymentSucceededEnvelope,
  parseOrderPaymentOutcomeDisposition,
  createOrderPaymentDispositionBinding,
  OrderPaymentOutcomeError,
} from "./order-payment-outcome.js";
/** A waiting fact is not a terminal payment disposition or permission to release Kitchen. */
export function parseOrderPaymentAcceptanceWait(
  eventValue: unknown,
  recordValue: unknown,
  sha256: (value: string) => string,
) {
  const event = parsePaymentSucceededEnvelope(eventValue),
    record = parseOrderPaymentOutcomeDisposition(recordValue);
  if (
    record.disposition !== "AwaitingAcceptance" ||
    record.brandReference !== event.tenantId ||
    record.storeReference !== event.storeId ||
    record.orderReference !== event.payload.orderReference ||
    record.paymentEventReference !== event.eventId ||
    record.paymentTransactionReference !== event.payload.paymentTransactionReference ||
    record.paymentIntentReference !== event.payload.paymentIntentReference ||
    record.paymentAttemptReference !== event.payload.paymentAttemptReference ||
    record.evaluatedAt < event.occurredAt ||
    record.sourceDigest !==
      sha256(createOrderPaymentDispositionBinding({ event, disposition: record }))
  )
    throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
  return Object.freeze({ event, record });
}
