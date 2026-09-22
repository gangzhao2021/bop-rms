import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  decodeOrderFulfillmentCompletionRecord,
  encodeOrderFulfillmentCompletionRecord,
  validateOrderFulfillmentCompletionRecord,
  OrderFulfillmentCompletionError,
  type OrderFulfillmentCompletionRecord,
} from "../../application/order-fulfillment-completion-record.js";
import { parseOrderingReference } from "../../domain/cart.js";
import { createPostgresOrderInitialExecutionReader } from "./order-termination-store.js";

const columns = {
  completionReference: "completion_id",
  operationReference: "operation_id",
  auditReference: "audit_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  orderReference: "order_id",
  orderBatchReference: "order_batch_id",
  expectedSourceCheckpoint: "expected_source_checkpoint",
  expectedOrderVersion: "expected_order_version",
  fulfilledOrderVersion: "fulfilled_order_version",
  phaseBefore: "previous_phase",
  phase: "phase",
  closureStatus: "closure_status",
  workflowVersionReference: "workflow_version_id",
  transitionReference: "transition_id",
  sourceDigest: "source_digest",
  completedAt: "completed_at",
  recordedAt: "recorded_at",
} as const;
const keys = Object.keys(columns) as (keyof typeof columns)[];
function fail(conflict = false): never {
  throw new OrderFulfillmentCompletionError(
    conflict ? "ORDER_FULFILLMENT_COMPLETION_CONFLICT" : "ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE",
  );
}

/** Caller retains all eligibility fences until commit. */
export function createPostgresOrderFulfillmentCompletionStore(options: {
  brandReference: string;
  storeReference: string;
  sha256(value: string): string;
  authorize(
    transaction: ConsumerTransaction,
    record: OrderFulfillmentCompletionRecord,
  ): Promise<boolean>;
  validateCurrentWorkflow(
    transaction: ConsumerTransaction,
    record: OrderFulfillmentCompletionRecord,
  ): Promise<boolean>;
  audit(record: OrderFulfillmentCompletionRecord): Promise<unknown>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async commit(input: { transaction: ConsumerTransaction; record: unknown }) {
      const record = validateOrderFulfillmentCompletionRecord(input.record, options.sha256),
        tx = input.transaction;
      if (record.brandReference !== brand || record.storeReference !== store) return fail();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      if ((await options.authorize(tx, record)) !== true) return fail();
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingOrderDisposition:" + brand + ":" + store + ":" + record.orderReference,
      ]);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingFulfillmentOperation:" + brand + ":" + store + ":" + record.operationReference,
      ]);
      const prior = await tx.query(
        "SELECT completion_record_json::text AS record FROM rms_ordering.order_fulfillment_completion_record " +
          "WHERE brand_id=$1 AND store_id=$2 AND (operation_id=$3 OR order_id=$4 OR source_event_id=$5) LIMIT 2",
        [
          brand,
          store,
          record.operationReference,
          record.orderReference,
          record.sourceEvent.eventId,
        ],
      );
      if (prior.rows.length > 1) return fail(true);
      if (prior.rows.length === 1) {
        const original = decodeOrderFulfillmentCompletionRecord(
          prior.rows[0]?.record,
          options.sha256,
        );
        if (
          encodeOrderFulfillmentCompletionRecord(original, options.sha256) !==
          encodeOrderFulfillmentCompletionRecord(record, options.sha256)
        )
          return fail(true);
        return Object.freeze({ status: "AlreadyCommitted" as const, record: original });
      }
      const state = await createPostgresOrderInitialExecutionReader({
        brandReference: brand,
        storeReference: store,
        // This private invocation follows current authorization above under the same scope.
        authorize: async () => true,
      }).loadByBatch({
        transaction: tx,
        orderReference: record.orderReference,
        orderBatchReference: record.orderBatchReference,
      });
      if (
        state.phase !== record.phaseBefore ||
        state.version !== record.expectedOrderVersion ||
        state.checkpoint !== record.expectedSourceCheckpoint ||
        record.completedAt < state.occurredAt
      )
        return fail(true);
      const header = await tx.query(
        "SELECT order_type FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR SHARE",
        [brand, store, record.orderReference],
      );
      if (header.rows.length !== 1 || header.rows[0]?.order_type !== "Pickup") return fail(true);
      if ((await options.validateCurrentWorkflow(tx, record)) !== true) return fail();
      const audit = validateAuditRecord(await options.audit(record));
      if (
        audit.auditId !== record.auditReference ||
        audit.brandId !== brand ||
        audit.storeId !== store ||
        audit.actor.type !== "System" ||
        audit.actionCode !== "ORDER_FULFILLED" ||
        audit.targetType !== "Order" ||
        audit.targetId !== record.orderReference ||
        audit.correlationId !== record.operationReference ||
        audit.occurredAt !== record.recordedAt ||
        audit.beforeSummary !== undefined ||
        JSON.stringify(audit.afterSummary) !==
          JSON.stringify({ phase: "Fulfilled", closureStatus: "Open" }) ||
        audit.dataClassification !== "Restricted"
      )
        return fail(true);
      if ((await options.authorize(tx, record)) !== true) return fail();
      await tx.query("SAVEPOINT ordering_fulfillment_completion", []);
      try {
        const values = keys.map((key): unknown => record[key]);
        values.push(
          record.sourceEvent.eventId,
          encodeOrderFulfillmentCompletionRecord(record, options.sha256),
        );
        const inserted = await tx.query(
          "INSERT INTO rms_ordering.order_fulfillment_completion_record (" +
            keys.map((key) => columns[key]).join(",") +
            ",source_event_id,completion_record_json) VALUES (" +
            values.map((_, index) => "$" + (index + 1)).join(",") +
            ")",
          values,
        );
        if (inserted.rowCount !== 1) return fail(true);
        await appendAuditRecordInTransaction(tx, audit);
        const revision = await tx.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) " +
            "SELECT $4::uuid,$1::uuid,$2::uuid,$3::uuid,'Fulfillment',$5::integer,$6::integer,r.revision_id,NULL,$7::timestamptz FROM rms_ordering.order_revision r " +
            "WHERE r.brand_id=$1::uuid AND r.store_id=$2::uuid AND r.order_id=$3::uuid AND r.version=$6::integer AND r.occurred_at<=$7::timestamptz AND r.revision_id=$8::uuid",
          [
            brand,
            store,
            record.orderReference,
            record.completionReference,
            record.fulfilledOrderVersion,
            record.expectedOrderVersion,
            record.recordedAt,
            record.expectedSourceCheckpoint,
          ],
        );
        if (revision.rowCount !== 1) return fail(true);

        await tx.query("RELEASE SAVEPOINT ordering_fulfillment_completion", []);
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_fulfillment_completion", []);
        await tx.query("RELEASE SAVEPOINT ordering_fulfillment_completion", []);
        return fail();
      }
      return Object.freeze({ status: "Created" as const, record });
    },
  });
}
