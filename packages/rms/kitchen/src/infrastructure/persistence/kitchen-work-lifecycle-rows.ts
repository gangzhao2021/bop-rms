import {
  parseKitchenWorkLifecycleEffect,
  type KitchenWorkLifecycleEffectValidationPorts,
} from "../../application/kitchen-work-lifecycle-service.js";
import { encodeKitchenWorkLifecycleRecord } from "../../application/kitchen-work-lifecycle-record.js";
import type { KitchenWorkLifecycleOperationRecord } from "../../application/ports/kitchen-work-lifecycle-ports.js";
import type { KitchenCapturedExpoDecision } from "../../contracts/kitchen-work-lifecycle.js";

const version = (value: bigint | null) => (value === null ? null : value.toString());
function expo(value: KitchenCapturedExpoDecision | null) {
  return {
    expo_source_operation_id: value?.sourceOperationReference ?? null,
    expo_source_action_code: value?.sourceActionCode ?? null,
    expo_source_expected_ticket_version: value ? version(value.sourceExpectedTicketVersion) : null,
    expo_source_result_ticket_version: value ? version(value.sourceCommittedTicketVersion) : null,
    expo_source_expected_work_item_version: value
      ? version(value.sourceExpectedWorkItemVersion)
      : null,
    expo_source_result_work_item_version: value
      ? version(value.sourceCommittedWorkItemVersion)
      : null,
    expo_source_before_status: value?.sourceBeforeStatus ?? null,
    expo_source_after_status: value?.sourceAfterStatus ?? null,
    expo_source_completed_quantity: value?.sourceCompletedQuantity ?? null,
    expo_source_required_quantity: value?.sourceRequiredQuantity ?? null,
    expo_source_outcome: value?.sourceOutcome ?? null,
    expo_source_occurred_at: value?.sourceOccurredAt ?? null,
    captured_expo_binding_digest: value?.capturedExpoBindingDigest ?? null,
    expo_decision_id: value?.decisionReference ?? null,
    expo_decision_version: value?.decisionVersion ?? null,
    expo_decision_digest: value?.decisionDigest ?? null,
    expo_producer_contract_version: value?.producerContractVersion ?? null,
    expo_decision_purpose: value?.decisionPurpose ?? null,
    expo_mode: value?.mode ?? null,
    expo_evaluated_at: value?.evaluatedAt ?? null,
    expo_valid_until: value?.validUntil ?? null,
  };
}
function operation(
  value: KitchenWorkLifecycleOperationRecord,
  outcome: string,
  effectDigest: string,
  child: string | null,
  record: string | null,
) {
  const admission = value.admissionDecision;
  return Object.freeze({
    kitchen_work_lifecycle_operation_id: value.operationReference,
    brand_id: value.brandReference,
    store_id: value.storeReference,
    kitchen_ticket_id: value.ticketReference,
    kitchen_work_item_id: value.workItemReference,
    order_item_id: value.orderItemReference,
    idempotency_key: value.idempotencyKey,
    action_code: value.actionCode,
    purpose: value.purpose,
    reason_code: value.reasonCode,
    outcome,
    actor_type: value.actorType,
    actor_id: value.actorReference,
    source_channel: value.sourceChannel,
    data_classification: "Confidential",
    intent_digest: value.intentDigest,
    effect_digest: effectDigest,
    expected_ticket_version: version(value.expectedTicketVersion),
    result_ticket_version: version(value.resultTicketVersion),
    expected_work_item_version: version(value.expectedWorkItemVersion),
    result_work_item_version: version(value.resultWorkItemVersion),
    before_work_item_status: value.beforeStatus,
    after_work_item_status: value.afterStatus,
    quantity_delta: value.quantityDelta,
    completed_quantity: value.completedQuantity,
    required_quantity: value.requiredQuantity,
    accepted_operation_id: value.acceptedOperationReference,
    started_operation_id: value.startedOperationReference,
    automatic_child_operation_id: child,
    admission_decision_id: admission?.decisionReference ?? null,
    admission_decision_version: admission?.decisionVersion ?? null,
    admission_decision_digest: admission?.decisionDigest ?? null,
    admission_producer_contract_version: admission?.producerContractVersion ?? null,
    admission_outcome: admission?.outcome ?? null,
    admission_evaluated_at: admission?.evaluatedAt ?? null,
    admission_valid_until: admission?.validUntil ?? null,
    ...expo(value.capturedExpo),
    ready_result_id: value.readyResultReference,
    audit_id: value.auditReference,
    audit_semantic_digest: value.auditSemanticDigest,
    outbox_event_id: value.eventReference,
    event_semantic_digest: value.eventSemanticDigest,
    correlation_id: value.correlationReference,
    causation_operation_id: value.causationReference,
    occurred_at: value.occurredAt,
    replay_expires_at: value.replayExpiresAt,
    effect_record_json: record,
  });
}

/** Exact owner table rows. Caller still owns authorization, version fences and atomic persistence. */
export function createKitchenWorkLifecycleRows(
  value: unknown,
  ports: KitchenWorkLifecycleEffectValidationPorts,
) {
  const effect = parseKitchenWorkLifecycleEffect(value, ports);
  const child = effect.automaticReadyOperation;
  const ready = effect.readyResult;
  const publication = effect.readyPublication;
  return Object.freeze({
    effect,
    operation: operation(
      effect.operation,
      effect.result.outcome,
      effect.effectDigest,
      child?.operationReference ?? null,
      encodeKitchenWorkLifecycleRecord(effect, ports),
    ),
    automaticOperation:
      child && effect.automaticReadyEffectDigest
        ? operation(child, "OrderItemReady", effect.automaticReadyEffectDigest, null, null)
        : null,
    readyResult: ready
      ? Object.freeze({
          ready_result_id: ready.readyResultReference,
          brand_id: ready.brandReference,
          store_id: ready.storeReference,
          kitchen_ticket_id: ready.ticketReference,
          order_item_id: ready.orderItemReference,
          causal_operation_id: ready.causalOperationReference,
          actor_type: ready.actorType,
          actor_id: ready.actorReference,
          work_items_json: JSON.stringify(
            ready.workItems.map((item) => ({
              workItemReference: item.workItemReference,
              workItemVersion: item.workItemVersion.toString(),
            })),
          ),
          work_items_digest: ready.workItemsDigest,
          ready_quantity: ready.readyQuantity,
          required_quantity: ready.requiredQuantity,
          ...expo(ready.capturedExpo),
          ready_at: ready.readyAt,
        })
      : null,
    readyPublication: publication
      ? Object.freeze({
          kitchen_ready_publication_id: publication.publicationReference,
          brand_id: publication.brandReference,
          store_id: publication.storeReference,
          kitchen_ticket_id: publication.ticketReference,
          order_id: publication.orderReference,
          order_batch_id: publication.orderBatchReference,
          order_item_id: publication.orderItemReference,
          ready_result_id: publication.readyResultReference,
          ticket_version: version(publication.ticketVersion),
          ready_quantity: publication.readyQuantity,
          required_quantity: publication.requiredQuantity,
          ticket_item_count: publication.itemCount,
          item_outbox_event_id: publication.itemEvent.eventId,
          item_event_semantic_digest: publication.itemEventSemanticDigest,
          order_outbox_event_id: publication.orderEvent?.eventId ?? null,
          order_event_semantic_digest: publication.orderEventSemanticDigest,
          correlation_id: publication.correlationReference,
          causation_operation_id: publication.causationReference,
          occurred_at: publication.occurredAt,
          data_classification: "IndirectIdentifier",
          retention_policy_code: "KitchenBusinessRecord",
        })
      : null,
  });
}
