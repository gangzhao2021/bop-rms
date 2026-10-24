import {
  createPostgresWorkflowDefinitionStore,
  parseWorkflowActionRequest,
  workflowUnavailable,
  type WorkflowTransaction,
} from "@bop/workflow";
import {
  createOrderBatchCheckoutCancellation,
  summarizeOrderItemProgress,
  parseOrderingReference,
} from "@rms/ordering";
import type { evaluateOrderAcceptanceWorkflow } from "./order-acceptance-workflow.js";
/** Current owner facts and System authority must be supplied under retained fences.
 * The workflow principal is server configured; the Audit actor remains System.
 */
export async function evaluateDiningBatchCancellationWorkflow(input: {
  transaction: WorkflowTransaction;
  source: Parameters<typeof createOrderBatchCheckoutCancellation>[0];
  request: unknown;
  systemActorReference: string;
  policy: Readonly<{ action: string; purposeCode: string; permissionCode: string }>;
  gates: Parameters<typeof evaluateOrderAcceptanceWorkflow>[0]["gates"];
}) {
  const result = createOrderBatchCheckoutCancellation(input.source),
    record = result.record;
  const before = summarizeOrderItemProgress(input.source.items);
  const request = parseWorkflowActionRequest(input.request);
  const principal = parseOrderingReference(input.systemActorReference),
    policy = Object.freeze({ ...input.policy });
  if (
    !policy.action ||
    !policy.purposeCode ||
    !policy.permissionCode ||
    String(request.actorReference) !== String(principal) ||
    String(request.tenantReference) !== String(record.tenantReference) ||
    request.brandReference !== record.brandReference ||
    request.storeReference !== record.storeReference ||
    request.resourceReference !== record.orderReference ||
    request.resourceVersion !== record.expectedOrderVersion ||
    request.expectedVersionReference !== record.workflowVersionReference ||
    String(request.observedAt) !== String(record.cancelledAt) ||
    request.currentState !== before.phase ||
    request.applicabilityCode !== "DineIn" ||
    request.action !== policy.action ||
    request.purposeCode !== policy.purposeCode
  )
    return workflowUnavailable();
  const evaluated = await createPostgresWorkflowDefinitionStore(
    { run: (work) => work(input.transaction) },
    {
      tenantReference: record.tenantReference,
      brandReference: record.brandReference,
      storeReference: record.storeReference,
    },
  ).evaluatePublishedAction(request, {
    ...input.gates,
    authorizeAction: async (transaction, action) =>
      transaction === input.transaction &&
      action.transition.transitionReference === record.transitionReference &&
      action.transition.permissionCode === policy.permissionCode &&
      action.transition.nextState === result.progress.phase &&
      (await input.gates.authorizeAction(transaction, action)) === true,
  });
  if (
    evaluated.transition.transitionReference !== record.transitionReference ||
    evaluated.transition.nextState !== result.progress.phase ||
    evaluated.transition.permissionCode !== policy.permissionCode ||
    evaluated.transition.effects.length !== 0
  )
    return workflowUnavailable();
  return evaluated;
}
