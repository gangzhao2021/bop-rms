import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseOrderAcceptanceRecord,
  OrderAcceptanceRecordError,
  type OrderAcceptanceRecord,
} from "../../application/order-acceptance-record.js";
import { parseOrderingReference } from "../../domain/cart.js";

const columns = {
  acceptanceReference: "acceptance_id",
  operationReference: "operation_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  orderReference: "order_id",
  orderBatchReference: "order_batch_id",
  expectedOrderVersion: "expected_order_version",
  acceptedOrderVersion: "accepted_order_version",
  actorType: "actor_type",
  actorReference: "actor_id",
  purposeCode: "purpose_code",
  permissionCode: "permission_code",
  reasonCode: "reason_code",
  workflowVersionReference: "workflow_version_id",
  transitionReference: "transition_id",
  sourceDigest: "source_digest",
  acceptedAt: "accepted_at",
} as const;
const keys = Object.keys(columns) as (keyof typeof columns)[];
const selection = keys.map((key) => columns[key] + ' AS "' + key + '"').join(",");
function fail(conflict = false): never {
  throw new OrderAcceptanceRecordError(
    conflict ? "ORDER_ACCEPTANCE_RECORD_CONFLICT" : "ORDER_ACCEPTANCE_RECORD_UNAVAILABLE",
  );
}

async function lockOrder(
  transaction: ConsumerTransaction,
  brand: string,
  store: string,
  order: string,
) {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "OrderingOrderDisposition:" + brand + ":" + store + ":" + order,
  ]);
}

/** Historical owner fact only. Caller retains this transaction while evaluating current eligibility. */
export function createPostgresOrderAcceptanceReader(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    transaction: ConsumerTransaction,
    scope: Readonly<{
      brandReference: string;
      storeReference: string;
      orderReference: string;
      orderBatchReference: string;
    }>,
  ): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async loadByBatch(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      orderBatchReference: string;
    }): Promise<OrderAcceptanceRecord | null> {
      const order = parseOrderingReference(input.orderReference);
      const batch = parseOrderingReference(input.orderBatchReference);
      const tx = input.transaction;
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      if (
        (await options.authorize(
          tx,
          Object.freeze({
            brandReference: brand,
            storeReference: store,
            orderReference: order,
            orderBatchReference: batch,
          }),
        )) !== true
      )
        return fail();
      await lockOrder(tx, brand, store, order);
      const result = await tx.query(
        "SELECT " +
          selection +
          " FROM rms_ordering.order_acceptance_record " +
          "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 LIMIT 2",
        [brand, store, order, batch],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) return fail(true);
      const row = result.rows[0];
      const record = parseOrderAcceptanceRecord({
        ...row,
        acceptedAt:
          row?.acceptedAt instanceof Date ? row.acceptedAt.toISOString() : row?.acceptedAt,
      });
      if (
        record.brandReference !== brand ||
        record.storeReference !== store ||
        record.orderReference !== order ||
        record.orderBatchReference !== batch
      )
        return fail(true);
      return record;
    },
  });
}

/** Caller owns commit/rollback. Every owner gate must retain its fences through that commit. */
export function createPostgresOrderAcceptanceStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, record: OrderAcceptanceRecord): Promise<boolean>;
  validateCurrentSource(
    transaction: ConsumerTransaction,
    record: OrderAcceptanceRecord,
  ): Promise<boolean>;
  audit(record: OrderAcceptanceRecord): Promise<unknown>;
}) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async commit(input: { transaction: ConsumerTransaction; record: unknown }) {
      const record = parseOrderAcceptanceRecord(input.record);
      if (record.brandReference !== brand || record.storeReference !== store) return fail();
      const tx = input.transaction;
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      if ((await options.authorize(tx, record)) !== true) return fail();
      await lockOrder(tx, brand, store, record.orderReference);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingAcceptanceOperation:" + brand + ":" + store + ":" + record.operationReference,
      ]);
      const prior = await tx.query(
        "SELECT " +
          selection +
          " FROM rms_ordering.order_acceptance_record WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
        [brand, store, record.operationReference],
      );
      if (prior.rows.length > 1) return fail();
      if (prior.rows.length === 1) {
        const row = prior.rows[0];
        const original = parseOrderAcceptanceRecord({
          ...row,
          acceptedAt:
            row?.acceptedAt instanceof Date ? row.acceptedAt.toISOString() : row?.acceptedAt,
        });
        for (const key of keys) {
          if (
            key !== "acceptanceReference" &&
            key !== "acceptedAt" &&
            original[key] !== record[key]
          )
            return fail(true);
        }
        return Object.freeze({ status: "AlreadyCommitted" as const, record: original });
      }
      const terminated = await tx.query(
        "SELECT termination_id FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 1",
        [brand, store, record.orderReference],
      );
      if (terminated.rows.length !== 0) return fail(true);
      const batch = await tx.query(
        "SELECT submitted_at FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 FOR SHARE",
        [brand, store, record.orderReference, record.orderBatchReference],
      );
      if (batch.rows.length !== 1) return fail(true);
      const submitted = batch.rows[0]?.submitted_at;
      const submittedAt = submitted instanceof Date ? submitted.toISOString() : submitted;
      if (
        typeof submittedAt !== "string" ||
        !Number.isFinite(Date.parse(submittedAt)) ||
        Date.parse(record.acceptedAt) < Date.parse(submittedAt)
      )
        return fail(true);
      const accepted = await tx.query(
        "SELECT acceptance_id FROM rms_ordering.order_acceptance_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4",
        [brand, store, record.orderReference, record.orderBatchReference],
      );
      if (accepted.rows.length !== 0) return fail(true);
      if ((await options.validateCurrentSource(tx, record)) !== true) return fail();
      const audit = validateAuditRecord(await options.audit(record));
      if (
        audit.brandId !== brand ||
        audit.storeId !== store ||
        audit.actor.type !== record.actorType ||
        (audit.actor.type === "User" && audit.actor.reference !== record.actorReference) ||
        audit.actionCode !== "ORDER_ACCEPTED" ||
        audit.targetType !== "Order" ||
        audit.targetId !== record.orderReference ||
        audit.correlationId !== record.operationReference ||
        audit.reasonCode !== record.reasonCode ||
        audit.occurredAt !== record.acceptedAt ||
        audit.beforeSummary !== undefined ||
        JSON.stringify(audit.afterSummary) !== JSON.stringify({ phase: "Accepted" }) ||
        audit.dataClassification !== "Restricted"
      )
        return fail(true);
      if ((await options.authorize(tx, record)) !== true) return fail();
      await tx.query("SAVEPOINT ordering_acceptance_revision", []);
      try {
        const result = await tx.query(
          "INSERT INTO rms_ordering.order_acceptance_record (" +
            keys.map((key) => columns[key]).join(",") +
            ") VALUES (" +
            keys.map((_, index) => "$" + (index + 1)).join(",") +
            ")",
          keys.map((key) => record[key]),
        );
        if (result.rowCount !== 1) return fail(true);
        await appendAuditRecordInTransaction(tx, audit);
        const revision = await tx.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) " +
            "SELECT $4::uuid,$1::uuid,$2::uuid,$3::uuid,'Acceptance',$5::integer,$6::integer,r.revision_id,NULL,$7::timestamptz FROM rms_ordering.order_revision r " +
            "WHERE r.brand_id=$1::uuid AND r.store_id=$2::uuid AND r.order_id=$3::uuid AND r.version=$6::integer AND r.occurred_at<=$7::timestamptz",
          [
            brand,
            store,
            record.orderReference,
            record.acceptanceReference,
            record.acceptedOrderVersion,
            record.expectedOrderVersion,
            record.acceptedAt,
          ],
        );
        if (revision.rowCount !== 1) return fail(true);
        await tx.query("RELEASE SAVEPOINT ordering_acceptance_revision", []);
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_acceptance_revision", []);
        await tx.query("RELEASE SAVEPOINT ordering_acceptance_revision", []);
        return fail(true);
      }
      return Object.freeze({ status: "Created" as const, record });
    },
  });
}
