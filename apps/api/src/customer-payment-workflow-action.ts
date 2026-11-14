import { CustomerInventorySourceError } from "./customer-submission-inventory-source.js";
import { createPostgresWorkflowDefinitionStore, parseWorkflowActionRequest } from "@bop/workflow";
import {
  evaluateIntactReservationPaymentRule,
  parseInventoryReference,
  type CurrentSubmissionInventoryFacts,
  type InventoryItemTransaction,
} from "@rms/inventory";
import {
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  parseAdditionalDiningBatchSnapshot,
  createPostgresDiningOrderPreparationSource,
} from "@rms/ordering";
import { customerPaymentConsumerTransaction } from "./customer-order-payment-admission.js";
import { parsePaymentIntentCreationRecord, type PaymentIntentCreationRecord } from "@rms/payment";
import type { CustomerInventoryWorkflowGates } from "./customer-submission-inventory-workflow-source.js";

/** Explicit selected action/rule bindings. No inferred Store policy, permission or transition execution. */
export function createCustomerIntactReservationPaymentAction(
  options: Readonly<{
    scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
    currentOrder: unknown;
    submissionKind?: "Additional";
    quoteVersion: 1 | 2;
    workflow: Readonly<{
      purposeCode: string;
      action: string;
      permissionCode: string;
      paymentCommandCode: string;
      intactReservationRuleReference: string;
    }>;
    authorize: (
      tx: InventoryItemTransaction,
      input: Readonly<{ submissionReference: string; actorReference: string }>,
    ) => Promise<boolean>;
    authorizeOverride: CustomerInventoryWorkflowGates["authorizeOverride"];
  }>,
) {
  const scope = Object.freeze({
    tenantReference: String(parseInventoryReference(options.scope.tenantReference)),
    brandReference: String(parseInventoryReference(options.scope.brandReference)),
    storeReference: String(parseInventoryReference(options.scope.storeReference)),
  });
  const additional =
    options.submissionKind === "Additional"
      ? parseAdditionalDiningBatchSnapshot(options.currentOrder)
      : null;
  const initial =
    additional === null
      ? options.quoteVersion === 2
        ? parseConfiguredOrderCreationRecord(options.currentOrder)
        : parseOrderCreationRecord(options.currentOrder)
      : null;
  if (additional !== null && additional.snapshotVersion !== options.quoteVersion)
    throw new CustomerInventorySourceError();
  const batch = additional?.batch ?? initial?.order.batches[0];
  const orderReference = additional?.orderReference ?? initial?.order.orderReference;
  const brandReference = additional?.brandReference ?? initial?.order.brandReference;
  const storeReference = additional?.storeReference ?? initial?.order.storeReference;
  const guestSessionReference = additional?.guestSessionReference ?? initial?.guestSessionReference;
  const submissionReference = additional?.batch.submissionReference ?? initial?.submissionReference;
  const snapshotAt = additional?.batch.submittedAt ?? initial?.createdAt;
  if (!batch || !orderReference || !guestSessionReference || !submissionReference || !snapshotAt)
    throw new CustomerInventorySourceError();
  const workflow = Object.freeze({
    ...options.workflow,
    intactReservationRuleReference: String(
      parseInventoryReference(options.workflow.intactReservationRuleReference),
    ),
  });
  if (workflow.paymentCommandCode !== "CreatePaymentIntent")
    throw new CustomerInventorySourceError();
  const { authorize, authorizeOverride } = options;
  return async (
    tx: InventoryItemTransaction,
    input: Readonly<{
      payment: PaymentIntentCreationRecord;
      inventory: CurrentSubmissionInventoryFacts;
    }>,
  ): Promise<boolean> => {
    try {
      const payment = parsePaymentIntentCreationRecord(input.payment);
      const p = payment.intent.preparation;
      const final = input.inventory.record;
      if (
        String(brandReference) !== scope.brandReference ||
        String(storeReference) !== scope.storeReference ||
        String(final.tenantReference) !== scope.tenantReference ||
        String(final.brandReference) !== scope.brandReference ||
        String(final.storeReference) !== scope.storeReference ||
        String(final.orderReference) !== String(orderReference) ||
        String(p.orderReference) !== String(orderReference) ||
        String(p.orderBatchReference) !== String(batch.orderBatchReference) ||
        String(p.guestSessionReference) !== String(guestSessionReference) ||
        String(final.actorReference) !== String(guestSessionReference) ||
        String(final.submissionReference) !== String(submissionReference) ||
        String(p.submissionReference) !== String(submissionReference) ||
        String(final.cartReference) !== String(batch.sourceCartReference) ||
        final.cartVersion !== batch.sourceCartVersion ||
        String(final.quoteReference) !== String(batch.quoteReference) ||
        snapshotAt > input.inventory.observedAt
      )
        return false;
      let orderVersion: number | undefined = initial?.order.aggregateVersion;
      let canonicalPhase: string | undefined = initial?.order.canonicalPhase;
      const orderType = additional === null ? initial?.order.orderType : "DineIn";
      if (additional !== null) {
        const current = await createPostgresDiningOrderPreparationSource({
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          authorize: async () =>
            authorize(tx, { submissionReference, actorReference: guestSessionReference }),
        }).resolveCurrent({
          transaction: customerPaymentConsumerTransaction(tx),
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          orderReference,
          diningSessionReference: additional.diningSessionReference,
          guestSessionReference,
          observedAt: input.inventory.observedAt,
        });
        if (current === null || current.orderVersion < additional.expectedOrderVersion + 1)
          return false;
        orderVersion = current.orderVersion;
        canonicalPhase = current.canonicalPhase;
      }
      if (orderVersion === undefined || canonicalPhase === undefined || orderType === undefined)
        return false;
      const request = parseWorkflowActionRequest({
        ...scope,
        actorReference: guestSessionReference,
        resourceReference: orderReference,
        resourceVersion: orderVersion,
        purposeCode: workflow.purposeCode,
        applicabilityCode: orderType,
        expectedVersionReference: final.workflowVersionReference,
        currentState: canonicalPhase,
        action: workflow.action,
        observedAt: input.inventory.observedAt,
      });
      const store = createPostgresWorkflowDefinitionStore({ run: async (work) => work(tx) }, scope);
      const result = await store.evaluatePublishedAction(request, {
        authorizeResource: async (transaction) =>
          (await authorize(transaction, {
            submissionReference: submissionReference,
            actorReference: guestSessionReference,
          })) === true,
        authorizeOverride,
        authorizeAction: async (_transaction, { transition }) =>
          transition.permissionCode === workflow.permissionCode &&
          transition.nextState === canonicalPhase &&
          transition.ruleReferences.length === 1 &&
          transition.ruleReferences[0] === workflow.intactReservationRuleReference &&
          transition.effects.length === 1 &&
          transition.effects[0]?.ownerModule === "payment" &&
          transition.effects[0]?.commandCode === workflow.paymentCommandCode,
        evaluateRule: async (_transaction, { ruleReference }) =>
          ruleReference === workflow.intactReservationRuleReference &&
          evaluateIntactReservationPaymentRule(input.inventory),
      });
      return (
        result.definition.workflowReference === final.workflowReference &&
        result.definition.versionNumber === final.workflowVersion
      );
    } catch {
      return false;
    }
  };
}
