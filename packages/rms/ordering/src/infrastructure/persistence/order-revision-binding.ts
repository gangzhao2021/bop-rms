import {
  ORDER_REVISION_KIND_POLICY,
  orderRevisionKindsWhere,
  type OrderRevisionKindPolicy,
  type OrderRevisionOwnerRecord,
} from "../../domain/order-revision-kind.js";

/**
 * SQL predicate (over `rms_ordering.order_revision r`) that the revision's owning persisted
 * operation record describes exactly that revision. Exhaustive: a new owner record fails
 * compilation until its binding is written here.
 */
export function orderRevisionOwnerBindingSql(record: OrderRevisionOwnerRecord): string {
  switch (record) {
    case "InitialSubmission":
      return "EXISTS (SELECT 1 FROM rms_ordering.order_submission_record s JOIN rms_ordering.order_batch b ON b.submission_id=s.submission_id AND b.brand_id=s.brand_id AND b.store_id=s.store_id AND b.order_id=s.order_id WHERE s.brand_id=r.brand_id AND s.store_id=r.store_id AND s.order_id=r.order_id AND s.submission_id=r.revision_id AND s.submission_kind='Initial' AND b.submitted_at=r.occurred_at)";
    case "AdditionalBatchRecord":
      return "EXISTS (SELECT 1 FROM rms_ordering.additional_dining_batch_record a JOIN rms_ordering.order_batch b ON b.order_batch_id=a.order_batch_id AND b.brand_id=a.brand_id AND b.store_id=a.store_id AND b.order_id=a.order_id AND b.submission_id=a.submission_id WHERE a.brand_id=r.brand_id AND a.store_id=r.store_id AND a.order_id=r.order_id AND a.submission_id=r.revision_id AND b.submitted_at=r.occurred_at AND a.batch_sequence=(SELECT count(*)+1 FROM rms_ordering.order_revision p WHERE p.brand_id=r.brand_id AND p.store_id=r.store_id AND p.order_id=r.order_id AND p.kind='AdditionalBatch' AND p.version<=r.version))";
    case "AcceptanceRecord":
      return "EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=r.brand_id AND a.store_id=r.store_id AND a.order_id=r.order_id AND a.acceptance_id=r.revision_id AND a.expected_order_version=r.expected_version AND a.accepted_order_version=r.version AND a.accepted_at=r.occurred_at)";
    case "TerminationRecord":
      return "EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=r.brand_id AND t.store_id=r.store_id AND t.order_id=r.order_id AND t.termination_id=r.revision_id AND t.expected_order_version=r.expected_version AND t.terminated_order_version=r.version AND t.expected_source_checkpoint=r.previous_revision_id AND t.terminated_at=r.occurred_at)";
    case "FulfillmentCompletionRecord":
      return "EXISTS (SELECT 1 FROM rms_ordering.order_fulfillment_completion_record f WHERE f.brand_id=r.brand_id AND f.store_id=r.store_id AND f.order_id=r.order_id AND f.completion_id=r.revision_id AND f.expected_order_version=r.expected_version AND f.fulfilled_order_version=r.version AND f.expected_source_checkpoint=r.previous_revision_id AND f.recorded_at=r.occurred_at)";
    case "CheckoutBatchCancellation":
      return "EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c WHERE c.brand_id=r.brand_id AND c.store_id=r.store_id AND c.order_id=r.order_id AND c.cancellation_id=r.revision_id AND c.expected_source_checkpoint=r.previous_revision_id AND c.expected_order_version=r.expected_version AND c.cancelled_order_version=r.version AND c.cancelled_at=r.occurred_at)";
    case "StaffBatchCancellation":
      return "EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation c WHERE c.brand_id=r.brand_id AND c.store_id=r.store_id AND c.order_id=r.order_id AND c.cancellation_id=r.revision_id AND c.order_type='DineIn' AND c.expected_source_checkpoint=r.previous_revision_id AND c.expected_order_version=r.expected_version AND c.cancelled_order_version=r.version AND c.cancelled_at=r.occurred_at)";
    case "StaffItemCancellation":
      return "EXISTS (SELECT 1 FROM rms_ordering.order_item_staff_cancellation c WHERE c.brand_id=r.brand_id AND c.store_id=r.store_id AND c.order_id=r.order_id AND c.cancellation_id=r.revision_id AND c.expected_source_checkpoint=r.previous_revision_id AND c.expected_order_version=r.expected_version AND c.cancelled_order_version=r.version AND c.cancelled_at=r.occurred_at)";
    default: {
      const unhandled: never = record;
      throw new Error("ORDER_REVISION_BINDING_UNSUPPORTED:" + String(unhandled));
    }
  }
}

/**
 * `CASE r.kind ... END AS operation_bound` select column binding each revision to its owner record,
 * generated from ORDER_REVISION_KIND_POLICY. `include` limits the kinds a reader binds (for example
 * to avoid reading owner tables of kinds it rejects before the bound check); every other kind reads
 * as unbound (`false`).
 */
export function orderRevisionOperationBoundSql(
  include: (policy: OrderRevisionKindPolicy) => boolean = () => true,
): string {
  return (
    "CASE r.kind " +
    orderRevisionKindsWhere(include)
      .map(
        (kind) =>
          "WHEN '" +
          kind +
          "' THEN " +
          orderRevisionOwnerBindingSql(ORDER_REVISION_KIND_POLICY[kind].ownerRecord) +
          " ",
      )
      .join("") +
    "ELSE false END AS operation_bound "
  );
}
