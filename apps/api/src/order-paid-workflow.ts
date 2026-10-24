import {
  createPostgresWorkflowDefinitionStore,
  parseWorkflowActionRequest,
  workflowUnavailable,
  type WorkflowTransaction,
} from "@bop/workflow";
import type { createOrderPaidContextSource } from "./order-paid-context-source.js";
import type { evaluateOrderAcceptanceWorkflow } from "./order-acceptance-workflow.js";

type PaidContext = Awaited<ReturnType<ReturnType<typeof createOrderPaidContextSource>["resolve"]>>;

/** Evaluates release intent; current resource gate is required, and no confirmation is persisted. */
export async function evaluateOrderPaidWorkflow(input: {
  transaction: WorkflowTransaction;
  context: Pick<PaidContext, "order" | "acceptance" | "observedAt"> &
    Partial<Pick<PaidContext, "currentDining">>;
  request: unknown;
  release: Readonly<{
    action: string;
    purposeCode: string;
    permissionCode: string;
    nextState: string;
  }>;
  gates: Parameters<typeof evaluateOrderAcceptanceWorkflow>[0]["gates"];
}) {
  const request = parseWorkflowActionRequest(input.request);
  const { order, acceptance, observedAt } = input.context;
  const dining = input.context.currentDining;
  if (
    dining &&
    (dining.current.orderReference !== order.order.orderReference ||
      dining.current.brandReference !== order.order.brandReference ||
      dining.current.storeReference !== order.order.storeReference ||
      dining.current.diningSessionReference !== order.order.diningSessionReference ||
      dining.batch.cancellation !== null ||
      dining.batch.acceptance?.acceptanceReference !== acceptance?.acceptanceReference ||
      dining.current.orderVersion < (acceptance?.acceptedOrderVersion ?? 0))
  )
    return workflowUnavailable();
  const release = Object.freeze({ ...input.release });
  if (
    acceptance === null ||
    !release.action ||
    !release.purposeCode ||
    !release.permissionCode ||
    !release.nextState ||
    request.action !== release.action ||
    request.purposeCode !== release.purposeCode ||
    request.brandReference !== order.order.brandReference ||
    request.storeReference !== order.order.storeReference ||
    request.resourceReference !== order.order.orderReference ||
    request.applicabilityCode !== order.order.orderType ||
    request.currentState !== (dining?.current.canonicalPhase ?? "Accepted") ||
    request.resourceVersion !== (dining?.current.orderVersion ?? acceptance.acceptedOrderVersion) ||
    String(request.observedAt) !== String(observedAt) ||
    acceptance.acceptedAt > observedAt ||
    acceptance.brandReference !== order.order.brandReference ||
    acceptance.storeReference !== order.order.storeReference ||
    acceptance.orderReference !== order.order.orderReference ||
    !order.order.batches.some(
      (batch) => batch.orderBatchReference === acceptance.orderBatchReference,
    )
  )
    return workflowUnavailable();
  const store = createPostgresWorkflowDefinitionStore(
    { run: async (work) => work(input.transaction) },
    {
      tenantReference: request.tenantReference,
      brandReference: request.brandReference,
      storeReference: request.storeReference,
    },
  );
  return store.evaluatePublishedAction(request, {
    ...input.gates,
    authorizeAction: async (transaction, action) =>
      action.transition.permissionCode === release.permissionCode &&
      action.transition.nextState === release.nextState &&
      (await input.gates.authorizeAction(transaction, action)) === true,
  });
}
