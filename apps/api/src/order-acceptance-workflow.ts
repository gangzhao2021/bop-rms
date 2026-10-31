import type { createInitialDiningAcceptanceSource } from "./initial-dining-acceptance-source.js";
import {
  createPostgresWorkflowDefinitionStore,
  parseWorkflowActionRequest,
  workflowUnavailable,
  type WorkflowTransaction,
  type WorkflowTransactionActionGates,
} from "@bop/workflow";
import { parseOrderCreationRecord, parseConfiguredOrderCreationRecord } from "@rms/ordering";

type PublishedGates = Omit<WorkflowTransactionActionGates, "validatePublication"> & {
  authorizeOverride: WorkflowTransactionActionGates["validatePublication"];
};

/** Evaluate published policy under the caller's owner fences; not an acceptance fact or token. */
export async function evaluateOrderAcceptanceWorkflow(input: {
  transaction: WorkflowTransaction;
  order: unknown;
  /** Server-resolved owner source, never a request DTO. */
  currentDining?: Awaited<
    ReturnType<ReturnType<typeof createInitialDiningAcceptanceSource>["resolve"]>
  > | null;
  quoteVersion: 1 | 2;
  request: unknown;
  gates: PublishedGates;
  /** Trusted server configuration, never copied from the incoming action request. */
  acceptance: Readonly<{ action: string; purposeCode: string; permissionCode: string }>;
}) {
  const request = parseWorkflowActionRequest(input.request);
  const record =
    input.quoteVersion === 2
      ? parseConfiguredOrderCreationRecord(input.order)
      : parseOrderCreationRecord(input.order);
  const dining = input.currentDining;
  if (
    dining &&
    (record.order.orderType !== "DineIn" ||
      dining.order.submissionReference !== record.submissionReference ||
      dining.current.orderReference !== record.order.orderReference ||
      dining.current.brandReference !== record.order.brandReference ||
      dining.current.storeReference !== record.order.storeReference ||
      dining.current.diningSessionReference !== record.order.diningSessionReference ||
      dining.batch.sequence !== 1 ||
      dining.batch.cancellation !== null ||
      dining.batch.acceptance !== null)
  )
    return workflowUnavailable();
  if (
    !input.acceptance.action ||
    !input.acceptance.purposeCode ||
    !input.acceptance.permissionCode ||
    request.action !== input.acceptance.action ||
    request.purposeCode !== input.acceptance.purposeCode ||
    Date.parse(request.observedAt) < Date.parse(record.createdAt) ||
    request.brandReference !== record.order.brandReference ||
    request.storeReference !== record.order.storeReference ||
    request.resourceReference !== record.order.orderReference ||
    request.resourceVersion !== (dining?.current.orderVersion ?? record.order.aggregateVersion) ||
    request.currentState !== (dining?.current.canonicalPhase ?? record.order.canonicalPhase) ||
    request.applicabilityCode !== record.order.orderType
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
  const permissionCode = input.acceptance.permissionCode;
  return store.evaluatePublishedAction(request, {
    ...input.gates,
    authorizeAction: async (transaction, context) =>
      context.transition.nextState === "Accepted" &&
      context.transition.permissionCode === permissionCode &&
      (await input.gates.authorizeAction(transaction, context)) === true,
  });
}
