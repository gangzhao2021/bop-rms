import {
  createOrderPaymentConfirmationCandidate,
  createOrderExpiredPaymentDisposition,
  createOrderTerminatedPaymentDisposition,
  OrderPaymentOutcomeError,
  type OrderPaymentOutcomeConsumerPorts,
} from "@rms/ordering";
import { createOrderPaidContextSource } from "./order-paid-context-source.js";
import {
  parseExactPaidOutcomeEvent,
  createPendingAcceptanceCandidate,
} from "./order-pending-acceptance-source.js";
import { evaluateOrderPaidWorkflow } from "./order-paid-workflow.js";

type SourceInput = Parameters<OrderPaymentOutcomeConsumerPorts["source"]["loadExact"]>[0];
type PaidContext = Awaited<ReturnType<ReturnType<typeof createOrderPaidContextSource>["resolve"]>>;
type ReleaseEvaluation = Parameters<typeof evaluateOrderPaidWorkflow>[0];

/** Caller owns transaction/owner fences; only the consumer writer commits the returned candidate. */
export function createOrderPaidOutcomeSource(options: {
  context: ReturnType<typeof createOrderPaidContextSource>;
  release: ReleaseEvaluation["release"];
  generateDispositionReference(): string;
  generateConfirmationReference(): string;
  sha256(value: string): string;
  /** Trusted composition must supply actual current capabilities; history is not a resource gate. */
  resolveWorkflow(
    input: Readonly<{
      transaction: SourceInput["transaction"];
      context: PaidContext;
      event: ReturnType<typeof parseExactPaidOutcomeEvent>;
    }>,
  ): Promise<Pick<ReleaseEvaluation, "request" | "gates">>;
}): OrderPaymentOutcomeConsumerPorts["source"] {
  const release = Object.freeze({ ...options.release });
  return Object.freeze({
    async loadExact(input) {
      const event = parseExactPaidOutcomeEvent(input);
      const context = await options.context.resolve(input.transaction, event);
      if (
        context.initialExecution.phase === "Cancelled" ||
        context.initialExecution.phase === "Rejected"
      )
        return createOrderTerminatedPaymentDisposition({
          execution: context.initialExecution,
          preparation: context.payment.intent.preparation,
          paymentEvent: event,
          observedAt: context.observedAt,
          dispositionReference: options.generateDispositionReference(),
          sha256: options.sha256,
        });
      if (context.acceptance === null) {
        const order = context.order.order;
        if (
          order.canonicalPhase === "Submitted" &&
          context.initialExecution.phase === "Submitted" &&
          context.initialExecution.version === order.aggregateVersion &&
          context.initialExecution.checkpoint === context.order.submissionReference &&
          context.capacity?.commitment.state === "PaymentPending"
        ) {
          const expired = createOrderExpiredPaymentDisposition({
            orderType: order.orderType,
            execution: context.initialExecution,
            preparation: context.payment.intent.preparation,
            paymentEvent: event,
            observedAt: context.observedAt,
            dispositionReference: options.generateDispositionReference(),
            sha256: options.sha256,
          });
          if (expired !== null) return expired;
        }
        return createPendingAcceptanceCandidate(context, event, options);
      }
      if (
        context.initialExecution.phase !== "Accepted" ||
        context.initialExecution.version !== context.acceptance.acceptedOrderVersion ||
        context.initialExecution.checkpoint !== context.acceptance.acceptanceReference
      )
        throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
      const workflow = await options.resolveWorkflow({
        transaction: input.transaction,
        context,
        event,
      });
      const evaluated = await evaluateOrderPaidWorkflow({
        transaction: input.transaction,
        context,
        request: workflow.request,
        gates: workflow.gates,
        release,
      });
      // Evaluation does not execute owner commands. Never confirm while configured effects are unapplied.
      if (evaluated.transition.effects.length !== 0)
        throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
      return createOrderPaymentConfirmationCandidate({
        order: context.order,
        // The Order's own Quote version (it may predate the configured one).
        quoteVersion: context.quoteVersion,
        preparation: context.payment.intent.preparation,
        acceptance: context.acceptance,
        paymentEvent: event,
        observedAt: context.observedAt,
        dispositionReference: options.generateDispositionReference(),
        confirmationReference: options.generateConfirmationReference(),
        sha256: options.sha256,
      });
    },
  });
}
