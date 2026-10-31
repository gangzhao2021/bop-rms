import { parseOrderInitialExecution } from "./order-initial-execution.js";
import { parseOrderPaymentPreparationEvidence } from "./order-payment-preparation.js";
import { parseOrderingInstant, parseOrderingReference, parseOrderingHash } from "../domain/cart.js";
import {
  parsePaymentSucceededEnvelope,
  parseOrderPaymentOutcomeDisposition,
  createOrderPaymentDispositionBinding,
  OrderPaymentOutcomeError,
} from "./order-payment-outcome.js";

/** Caller retains current Ordering termination fence. This is not a refund authorization or result. */
export function createOrderTerminatedPaymentDisposition(input: {
  execution: unknown;
  preparation: unknown;
  paymentEvent: unknown;
  observedAt: string;
  dispositionReference: string;
  sha256(value: string): string;
}) {
  try {
    const execution = parseOrderInitialExecution(input.execution);
    const p = parseOrderPaymentPreparationEvidence(input.preparation);
    const event = parsePaymentSucceededEnvelope(input.paymentEvent);
    const observedAt = parseOrderingInstant(input.observedAt);
    if (
      (execution.phase !== "Cancelled" && execution.phase !== "Rejected") ||
      execution.brandReference !== p.brandReference ||
      execution.storeReference !== p.storeReference ||
      execution.orderReference !== p.orderReference ||
      execution.orderBatchReference !== p.orderBatchReference ||
      event.tenantId !== p.brandReference ||
      event.storeId !== p.storeReference ||
      event.payload.orderReference !== p.orderReference ||
      event.payload.amountMinor !== p.total.amountMinor.toString() ||
      event.payload.currencyCode !== p.total.currencyCode ||
      observedAt < execution.occurredAt ||
      observedAt < p.committedAt ||
      Date.parse(observedAt) < Date.parse(event.occurredAt)
    )
      throw new Error("unavailable");
    const disposition = parseOrderPaymentOutcomeDisposition({
      dispositionReference: parseOrderingReference(input.dispositionReference),
      brandReference: p.brandReference,
      storeReference: p.storeReference,
      orderReference: p.orderReference,
      orderBatchReference: p.orderBatchReference,
      submissionReference: p.submissionReference,
      paymentTransactionReference: event.payload.paymentTransactionReference,
      paymentIntentReference: event.payload.paymentIntentReference,
      paymentAttemptReference: event.payload.paymentAttemptReference,
      paymentEventReference: event.eventId,
      sourceVersion: execution.version,
      sourceCheckpoint: execution.checkpoint,
      sourceDigest: "sha256:" + "0".repeat(64),
      evaluatedAt: observedAt,
      disposition: "PaidWithoutFulfillableOrder",
      reason: execution.phase === "Cancelled" ? "SubmissionCancelled" : "OrderNoLongerFulfillable",
      kitchenReleaseDisposition: "Blocked",
    });
    return parseOrderPaymentOutcomeDisposition({
      ...disposition,
      sourceDigest: parseOrderingHash(
        input.sha256(createOrderPaymentDispositionBinding({ event, disposition })),
      ),
    });
  } catch {
    throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
  }
}
