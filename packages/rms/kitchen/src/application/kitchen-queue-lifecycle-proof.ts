import {
  parseKitchenWorkLifecycleEffect,
  type KitchenWorkLifecycleEffectValidationPorts,
} from "./kitchen-work-lifecycle-service.js";
import { parseLifecycleProofBundle } from "../domain/kitchen-queue-projection.js";
import { parseKitchenTicketReference } from "../domain/kitchen-ticket.js";
import type { KitchenWorkCancellationRecord } from "../contracts/kitchen-work-cancellation.js";

/** Projection proofs come only from fully validated immutable owner effects.
 * Supply the complete ticket history; the domain parser rejects gaps/duplicates.
 */
export function createKitchenQueueLifecycleProofBundle(input: {
  ticketReference: string;
  effects: readonly unknown[];
  validation: KitchenWorkLifecycleEffectValidationPorts;
  /** WP-2423 Q6: the ticket's staff cancellation rows, decoded by the owner store. */
  cancellations?: Readonly<{
    brandReference: string;
    storeReference: string;
    records: readonly KitchenWorkCancellationRecord[];
  }>;
}) {
  const ticketReference = parseKitchenTicketReference(input.ticketReference);
  const digest = (value: unknown) =>
    input.validation.digests.sha256(
      JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString(10) : item)),
    );
  const proofs: Record<string, unknown>[] = [];
  for (const value of input.effects) {
    const effect = parseKitchenWorkLifecycleEffect(value, input.validation);
    const op = effect.operation;
    if (op.ticketReference !== ticketReference) throw new Error("KITCHEN_QUEUE_SOURCE_MISMATCH");
    let parent: Record<string, unknown> | undefined;
    if (effect.event !== null) {
      const event = effect.event;
      parent = {
        kind: "Event",
        eventType: event.eventType,
        brandReference: op.brandReference,
        storeReference: op.storeReference,
        ticketReference: op.ticketReference,
        workItemReference: op.workItemReference,
        orderItemReference: op.orderItemReference,
        operationReference: op.operationReference,
        actionCode: op.actionCode,
        purpose: op.purpose,
        reasonCode: op.reasonCode,
        sourceChannel: op.sourceChannel,
        actor: { type: "User", actorReference: op.actorReference },
        expectedTicketVersion: op.expectedTicketVersion,
        committedTicketVersion: op.resultTicketVersion,
        expectedWorkItemVersion: op.expectedWorkItemVersion,
        committedWorkItemVersion: op.resultWorkItemVersion,
        beforeStatus: op.beforeStatus,
        afterStatus: op.afterStatus,
        quantityDelta: op.quantityDelta,
        completedQuantity: op.action === "CompleteKitchenWorkItem" ? op.completedQuantity : null,
        requiredQuantity: op.action === "CompleteKitchenWorkItem" ? op.requiredQuantity : null,
        occurredAt: op.occurredAt,
        auditReference: op.auditReference,
        auditSemanticDigest: op.auditSemanticDigest,
        effectDigest: effect.effectDigest,
        eventReference: op.eventReference,
        eventSemanticDigest: op.eventSemanticDigest,
      };
      parent.projectionProofDigest = digest(parent);
      proofs.push(parent);
    }
    const ready = effect.readyResult;
    if (ready !== null) {
      const auto = effect.automaticReadyOperation;
      const operation = auto ?? op;
      const proof: Record<string, unknown> =
        auto === null
          ? {
              kind: "ManualReady",
              brandReference: op.brandReference,
              storeReference: op.storeReference,
              ticketReference: op.ticketReference,
              workItemReference: effect.mutation.workItemReference,
              orderItemReference: op.orderItemReference,
              operationReference: op.operationReference,
              actionCode: op.actionCode,
              purpose: op.purpose,
              reasonCode: op.reasonCode,
              sourceChannel: op.sourceChannel,
              actor: { type: "User", actorReference: op.actorReference },
              expectedTicketVersion: op.expectedTicketVersion,
              committedTicketVersion: op.resultTicketVersion,
              workItemVersion: effect.mutation.resultWorkItemVersion,
              workItemStatus: "Completed",
            }
          : {
              kind: "AutomaticReady",
              brandReference: auto.brandReference,
              storeReference: auto.storeReference,
              ticketReference: auto.ticketReference,
              workItemReference: effect.mutation.workItemReference,
              orderItemReference: auto.orderItemReference,
              operationReference: auto.operationReference,
              parentOperationReference: auto.parentOperationReference,
              committedTicketVersion: auto.resultTicketVersion,
              workItemVersion: effect.mutation.resultWorkItemVersion,
              workItemStatus: "Completed",
              actionCode: auto.actionCode,
              purpose: auto.purpose,
              reasonCode: auto.reasonCode,
              sourceChannel: auto.sourceChannel,
              actor: { type: "System", actorReference: null },
            };
      Object.assign(proof, {
        workItems: ready.workItems,
        workItemsDigest: ready.workItemsDigest,
        readyResultReference: ready.readyResultReference,
        readyQuantity: ready.readyQuantity,
        requiredQuantity: ready.requiredQuantity,
        readyAt: ready.readyAt,
        auditReference: operation.auditReference,
        auditSemanticDigest: operation.auditSemanticDigest,
        effectDigest: auto === null ? effect.effectDigest : effect.automaticReadyEffectDigest,
        eventReference: null,
        eventSemanticDigest: null,
      });
      const projectionProofDigest = digest(proof);
      if (auto !== null) {
        if (!parent) throw new Error("KITCHEN_QUEUE_SOURCE_MISMATCH");
        proof.readyCausalBundleDigest = digest({
          parentProjectionProofDigest: parent.projectionProofDigest,
          childProjectionProofDigest: projectionProofDigest,
          readyResultReference: ready.readyResultReference,
          workItems: ready.workItems,
          workItemsDigest: ready.workItemsDigest,
          readyQuantity: ready.readyQuantity,
          requiredQuantity: ready.requiredQuantity,
          readyAt: ready.readyAt,
        });
      }
      proof.projectionProofDigest = projectionProofDigest;
      proofs.push(proof);
    }
  }
  for (const record of input.cancellations?.records ?? []) {
    if (record.ticketReference !== ticketReference)
      throw new Error("KITCHEN_QUEUE_SOURCE_MISMATCH");
    const proof: Record<string, unknown> = {
      kind: "Cancellation",
      brandReference: input.cancellations?.brandReference,
      storeReference: input.cancellations?.storeReference,
      ticketReference,
      workItemReference: record.workItemReference,
      orderItemReference: record.orderItemReference,
      operationReference: record.cancellationReference,
      cancellationOperationReference: record.operationReference,
      orderCancellationReference: record.orderCancellationReference,
      actionCode: "KITCHEN_WORK_CANCELLED",
      purpose: "KitchenOrderCancellation",
      reasonCode: "ORDER_CANCELLED_BEFORE_PREPARATION",
      sourceChannel: "MERCHANT_WEB",
      actor: { type: "User", actorReference: record.actorReference },
      expectedTicketVersion: record.expectedTicketVersion,
      committedTicketVersion: record.resultTicketVersion,
      expectedWorkItemVersion: record.expectedWorkItemVersion,
      committedWorkItemVersion: record.resultWorkItemVersion,
      beforeStatus: record.beforeStatus,
      afterStatus: "Cancelled",
      occurredAt: record.cancelledAt,
      evidenceDigest: record.evidenceDigest,
      auditReference: record.auditReference,
      eventReference: record.eventReference,
    };
    proof.projectionProofDigest = digest(proof);
    proofs.push(proof);
  }
  proofs.sort((a, b) => {
    const left = a.committedTicketVersion as bigint,
      right = b.committedTicketVersion as bigint;
    return left < right
      ? -1
      : left > right
        ? 1
        : String(a.operationReference) < String(b.operationReference)
          ? -1
          : String(a.operationReference) > String(b.operationReference)
            ? 1
            : 0;
  });
  return parseLifecycleProofBundle(
    {
      ticketReference,
      operationCount: proofs.length,
      readyResultCount: proofs.filter(
        (proof) => proof.kind === "ManualReady" || proof.kind === "AutomaticReady",
      ).length,
      lifecycleProofSetDigest: digest({
        normalizedProjectionProofs: proofs.map((proof) => ({
          committedTicketVersion: proof.committedTicketVersion,
          operationReference: proof.operationReference,
          projectionProofDigest: proof.projectionProofDigest,
        })),
      }),
      proofs,
    },
    input.validation.digests.sha256,
  );
}
