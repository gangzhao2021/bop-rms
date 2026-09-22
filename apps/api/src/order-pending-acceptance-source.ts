import {
  isPaidOrderWithinAcceptanceWindow,
  parsePaymentSucceededEnvelope,
  parseOrderPaymentOutcomeDisposition,
  createOrderPaymentDispositionBinding,
  parseOrderingReference,
  OrderPaymentOutcomeError,
  type OrderPaymentOutcomeConsumerPorts,
} from "@rms/ordering";
import { createOrderPaidContextSource } from "./order-paid-context-source.js";

/** Intermediate waiting branch. No accepted/expired/cancelled state can confirm through this source. */
export function createOrderPendingAcceptanceSource(options: {
  context: ReturnType<typeof createOrderPaidContextSource>;
  generateDispositionReference(): string;
  sha256(value: string): string;
}): OrderPaymentOutcomeConsumerPorts["source"] {
  return Object.freeze({
    async loadExact(input) {
      const event = parseExactPaidOutcomeEvent(input);
      const context = await options.context.resolve(input.transaction, event);
      return createPendingAcceptanceCandidate(context, event, options);
    },
  });
}

type PaidContext = Awaited<ReturnType<ReturnType<typeof createOrderPaidContextSource>["resolve"]>>;
type SourceInput = Parameters<OrderPaymentOutcomeConsumerPorts["source"]["loadExact"]>[0];

export function parseExactPaidOutcomeEvent(input: SourceInput) {
  const event = parsePaymentSucceededEnvelope(input.paymentEvent);
  if (
    input.brandReference !== event.tenantId ||
    input.storeReference !== event.storeId ||
    input.orderReference !== event.payload.orderReference ||
    input.paymentTransactionReference !== event.payload.paymentTransactionReference ||
    input.paymentIntentReference !== event.payload.paymentIntentReference ||
    input.paymentAttemptReference !== event.payload.paymentAttemptReference ||
    input.paymentEventReference !== event.eventId
  )
    throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
  return event;
}

export function createPendingAcceptanceCandidate(
  context: PaidContext,
  event: ReturnType<typeof parsePaymentSucceededEnvelope>,
  options: Pick<
    Parameters<typeof createOrderPendingAcceptanceSource>[0],
    "generateDispositionReference" | "sha256"
  >,
) {
  const p = context.payment.intent.preparation;
  if (
    context.acceptance !== null ||
    context.initialExecution.phase !== "Submitted" ||
    context.initialExecution.version !== context.order.order.aggregateVersion ||
    context.initialExecution.checkpoint !== context.order.submissionReference ||
    context.capacity === null ||
    context.order.order.canonicalPhase !== "Submitted" ||
    context.capacity.commitment.state !== "PaymentPending" ||
    !isPaidOrderWithinAcceptanceWindow({
      orderType: context.order.order.orderType,
      ...p,
      terminalOccurredAt: event.payload.terminalOccurredAt,
      observedAt: context.observedAt,
    })
  )
    return null;
  const pending = parseOrderPaymentOutcomeDisposition({
    dispositionReference: parseOrderingReference(options.generateDispositionReference()),
    brandReference: event.tenantId,
    storeReference: event.storeId,
    orderReference: p.orderReference,
    orderBatchReference: p.orderBatchReference,
    submissionReference: p.submissionReference,
    paymentTransactionReference: event.payload.paymentTransactionReference,
    paymentIntentReference: event.payload.paymentIntentReference,
    paymentAttemptReference: event.payload.paymentAttemptReference,
    paymentEventReference: event.eventId,
    sourceVersion: context.order.order.aggregateVersion,
    sourceCheckpoint: context.order.submissionReference,
    sourceDigest: "sha256:" + "0".repeat(64),
    evaluatedAt: context.observedAt,
    disposition: "AwaitingAcceptance",
    reason: "OrderAcceptancePending",
  });
  return parseOrderPaymentOutcomeDisposition({
    ...pending,
    sourceDigest: options.sha256(
      createOrderPaymentDispositionBinding({ event, disposition: pending }),
    ),
  });
}
