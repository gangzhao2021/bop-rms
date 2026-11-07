import {
  createPostgresWorkflowDefinitionStore,
  parseWorkflowActionRequest,
  workflowUnavailable,
  type WorkflowTransaction,
} from "@bop/workflow";
import {
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  parseOrderFulfillmentCompletionRecord,
} from "@rms/ordering";
import type { evaluateOrderAcceptanceWorkflow } from "./order-acceptance-workflow.js";

/** Evaluate published completion policy; owner persistence separately validates current history. */
export async function evaluateOrderFulfillmentWorkflow(input: {
  transaction: WorkflowTransaction;
  order: unknown;
  quoteVersion: 1 | 2;
  completion: unknown;
  request: unknown;
  fulfillment: Readonly<{ action: string; purposeCode: string; permissionCode: string }>;
  gates: Parameters<typeof evaluateOrderAcceptanceWorkflow>[0]["gates"];
}) {
  const request = parseWorkflowActionRequest(input.request);
  const completion = parseOrderFulfillmentCompletionRecord(input.completion);
  const order =
    input.quoteVersion === 2
      ? parseConfiguredOrderCreationRecord(input.order)
      : parseOrderCreationRecord(input.order);
  const policy = Object.freeze({ ...input.fulfillment });
  if (
    !policy.action ||
    !policy.purposeCode ||
    !policy.permissionCode ||
    request.action !== policy.action ||
    request.purposeCode !== policy.purposeCode ||
    completion.purposeCode !== policy.purposeCode ||
    completion.permissionCode !== policy.permissionCode ||
    completion.brandReference !== order.order.brandReference ||
    completion.storeReference !== order.order.storeReference ||
    completion.orderReference !== order.order.orderReference ||
    order.order.orderType !== "Pickup" ||
    completion.completedAt < order.createdAt ||
    !order.order.batches.some(
      (batch) => batch.orderBatchReference === completion.orderBatchReference,
    ) ||
    request.brandReference !== completion.brandReference ||
    request.storeReference !== completion.storeReference ||
    request.resourceReference !== completion.orderReference ||
    request.resourceVersion !== completion.expectedOrderVersion ||
    request.currentState !== completion.phaseBefore ||
    request.applicabilityCode !== "Pickup" ||
    request.expectedVersionReference !== completion.workflowVersionReference ||
    String(request.observedAt) !== String(completion.recordedAt)
  )
    return workflowUnavailable();
  const workflow = createPostgresWorkflowDefinitionStore(
    { run: async (work) => work(input.transaction) },
    {
      tenantReference: request.tenantReference,
      brandReference: request.brandReference,
      storeReference: request.storeReference,
    },
  );
  return workflow.evaluatePublishedAction(request, {
    ...input.gates,
    authorizeAction: async (transaction, context) =>
      context.transition.nextState === "Fulfilled" &&
      context.transition.permissionCode === policy.permissionCode &&
      context.transition.transitionReference === completion.transitionReference &&
      context.transition.effects.length === 0 &&
      (await input.gates.authorizeAction(transaction, context)) === true,
  });
}
