import { createPostgresWorkflowDefinitionStore, parseWorkflowActionRequest } from "@bop/workflow";
import {
  isPaidOrderWithinAcceptanceWindow,
  createOrderPaymentConfirmationCandidate,
  createOrderPaymentDispositionBinding,
  parseOrderPaymentOutcomeDisposition,
  parseOrderingReference,
  OrderPaymentOutcomeError,
  type OrderPaymentOutcomeConsumerPorts,
} from "@rms/ordering";
import { parseExactPaidOutcomeEvent } from "./order-pending-acceptance-source.js";
import type { createAdditionalOrderPaidContextSource } from "./additional-order-paid-context-source.js";
import type { evaluateOrderPaidWorkflow } from "./order-paid-workflow.js";

type Input = Parameters<OrderPaymentOutcomeConsumerPorts["source"]["loadExact"]>[0];
type Context = Awaited<
  ReturnType<ReturnType<typeof createAdditionalOrderPaidContextSource>["resolve"]>
>;
type Evaluation = Parameters<typeof evaluateOrderPaidWorkflow>[0];
const unavailable = (): never => {
  throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
};

/** Batch outcome source; consumer owns Inbox, disposition and Outbox transaction. */
export function createAdditionalOrderPaidOutcomeSource(options: {
  context: ReturnType<typeof createAdditionalOrderPaidContextSource>;
  quoteVersion: 1 | 2;
  release: Evaluation["release"];
  generateDispositionReference(): string;
  generateConfirmationReference(): string;
  sha256(value: string): string;
  resolveWorkflow(input: {
    transaction: Input["transaction"];
    context: Context;
    event: ReturnType<typeof parseExactPaidOutcomeEvent>;
  }): Promise<Pick<Evaluation, "request" | "gates">>;
}): OrderPaymentOutcomeConsumerPorts["source"] {
  const release = Object.freeze({ ...options.release });
  return Object.freeze({
    async loadExact(input) {
      const event = parseExactPaidOutcomeEvent(input);
      const context = await options.context.resolve(input.transaction, event);
      const { execution, observedAt, capacity } = context;
      const p = context.payment.intent.preparation;
      if (
        capacity.commitment.state !== "PaymentPending" ||
        !isPaidOrderWithinAcceptanceWindow({
          orderType: "DineIn",
          ...p,
          terminalOccurredAt: event.payload.terminalOccurredAt,
          observedAt,
        })
      )
        return unavailable();
      if (execution.acceptance === null) {
        if (execution.batchPhase !== "Submitted") return unavailable();
        const pending = parseOrderPaymentOutcomeDisposition({
          dispositionReference: parseOrderingReference(options.generateDispositionReference()),
          brandReference: p.brandReference,
          storeReference: p.storeReference,
          orderReference: p.orderReference,
          orderBatchReference: p.orderBatchReference,
          submissionReference: p.submissionReference,
          paymentTransactionReference: event.payload.paymentTransactionReference,
          paymentIntentReference: event.payload.paymentIntentReference,
          paymentAttemptReference: event.payload.paymentAttemptReference,
          paymentEventReference: event.eventId,
          sourceVersion: execution.batchVersion,
          sourceCheckpoint: execution.batchCheckpoint,
          sourceDigest: "sha256:" + "0".repeat(64),
          evaluatedAt: observedAt,
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
      if (execution.batchPhase !== "Accepted") return unavailable();
      const workflow = await options.resolveWorkflow({
        transaction: input.transaction,
        context,
        event,
      });
      const request = parseWorkflowActionRequest(workflow.request);
      const s = execution.snapshot;
      if (
        String(request.tenantReference) !== String(context.inventory.record.tenantReference) ||
        request.brandReference !== s.brandReference ||
        request.storeReference !== s.storeReference ||
        request.resourceReference !== s.orderReference ||
        request.resourceVersion !== execution.orderVersion ||
        request.applicabilityCode !== "DineIn" ||
        request.currentState !== execution.canonicalPhase ||
        String(request.observedAt) !== String(observedAt) ||
        request.action !== release.action ||
        request.purposeCode !== release.purposeCode
      )
        return unavailable();
      const evaluated = await createPostgresWorkflowDefinitionStore(
        { run: (work) => work(input.transaction) },
        {
          tenantReference: request.tenantReference,
          brandReference: request.brandReference,
          storeReference: request.storeReference,
        },
      ).evaluatePublishedAction(request, {
        ...workflow.gates,
        authorizeAction: async (transaction, action) =>
          action.transition.permissionCode === release.permissionCode &&
          action.transition.nextState === release.nextState &&
          (await workflow.gates.authorizeAction(transaction, action)) === true,
      });
      if (evaluated.transition.effects.length !== 0) return unavailable();
      return createOrderPaymentConfirmationCandidate({
        order: s,
        submissionKind: "Additional",
        quoteVersion: options.quoteVersion,
        preparation: p,
        acceptance: execution.acceptance,
        paymentEvent: event,
        observedAt,
        dispositionReference: options.generateDispositionReference(),
        confirmationReference: options.generateConfirmationReference(),
        sha256: options.sha256,
      });
    },
  });
}
