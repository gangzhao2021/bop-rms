import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import {
  parseOrderCancellationRequest,
  resolveOrderCancellationRequestHistory,
  type OrderCancellationRequest,
} from "../../domain/order-cancellation-request.js";
const columns = {
  requestReference: "request_id",
  operationReference: "operation_id",
  intentDigest: "intent_digest",
  tenantReference: "tenant_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  orderReference: "order_id",
  version: "aggregate_version",
  expectedOrderVersion: "expected_order_version",
  requestedByActorReference: "requested_by_actor_id",
  requestedByActorType: "requested_by_actor_type",
  requestReasonCode: "request_reason_code",
  requestedAt: "requested_at",
  status: "status",
  decidedByActorReference: "decided_by_actor_id",
  decisionReasonCode: "decision_reason_code",
  executionReference: "execution_id",
  occurredAt: "occurred_at",
} as const;
const keys = Object.keys(columns) as (keyof typeof columns)[];
const selection = keys.map((key) => columns[key] + ' AS "' + key + '"').join(",");
const fail = (): never => {
  throw new Error("ORDER_CANCELLATION_STORE_UNAVAILABLE");
};
function bind(row: Record<string, unknown>) {
  return parseOrderCancellationRequest({
    ...row,
    requestedAt: row.requestedAt instanceof Date ? row.requestedAt.toISOString() : row.requestedAt,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
  });
}
interface Query {
  orderReference: string;
  observedAt: string;
}
/** Caller owns commit/rollback. Mutation source must fence current Ordering version,
 * open lifecycle and Kitchen eligibility/loss evidence; this repository cannot grant authority. */
export function createPostgresOrderCancellationRequestStore(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  authorize(
    tx: ConsumerTransaction,
    query: Query,
    record: OrderCancellationRequest | null,
  ): Promise<boolean>;
  validateCurrentSource(
    tx: ConsumerTransaction,
    record: OrderCancellationRequest,
  ): Promise<boolean>;
  audit(record: OrderCancellationRequest): Promise<unknown>;
}) {
  const tenant = parseOrderingReference(options.tenantReference),
    brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  async function fence(tx: ConsumerTransaction, query: Query) {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrderingOrderDisposition:" + brand + ":" + store + ":" + query.orderReference,
    ]);
    const rows = await tx.query(
      "SELECT order_id::text,created_at FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE",
      [brand, store, query.orderReference],
    );
    const root = rows.rows[0];
    if (
      rows.rows.length !== 1 ||
      root?.order_id !== query.orderReference ||
      !(root.created_at instanceof Date) ||
      !Number.isFinite(root.created_at.getTime()) ||
      root.created_at.toISOString() > query.observedAt
    )
      return fail();
  }
  async function history(tx: ConsumerTransaction, query: Query) {
    const result = await tx.query(
      "SELECT " +
        selection +
        " FROM rms_ordering.order_cancellation_request_version WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY request_id,aggregate_version LIMIT 3001",
      [brand, store, query.orderReference],
    );
    if (result.rows.length > 3000) return fail();
    const records = result.rows.map(bind),
      grouped = new Map<string, OrderCancellationRequest[]>();
    for (const record of records) {
      if (
        record.tenantReference !== tenant ||
        record.brandReference !== brand ||
        record.storeReference !== store ||
        record.orderReference !== query.orderReference ||
        record.occurredAt > query.observedAt
      )
        return fail();
      const group = grouped.get(record.requestReference) ?? [];
      group.push(record);
      grouped.set(record.requestReference, group);
    }
    if (grouped.size > 1000) return fail();
    const requests = [...grouped.values()].map((values) =>
      resolveOrderCancellationRequestHistory(values),
    );
    return { records, requests };
  }
  return Object.freeze({
    async loadPosition(tx: ConsumerTransaction, input: Query) {
      try {
        const query = {
          orderReference: String(parseOrderingReference(input.orderReference)),
          observedAt: String(parseOrderingInstant(input.observedAt)),
        };
        if ((await options.authorize(tx, query, null)) !== true) return fail();
        await fence(tx, query);
        const state = await history(tx, query);
        if ((await options.authorize(tx, query, null)) !== true) return fail();
        return Object.freeze({
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          ...query,
          pendingCount: state.requests.filter((request) => request.pending).length,
          requests: Object.freeze(state.requests),
          snapshotDigest:
            "sha256:" +
            createHash("sha256")
              .update(JSON.stringify([tenant, brand, store, query.orderReference, state.records]))
              .digest("hex"),
        });
      } catch {
        return fail();
      }
    },
    async commit(tx: ConsumerTransaction, input: unknown) {
      try {
        const record = parseOrderCancellationRequest(input),
          query = { orderReference: record.orderReference, observedAt: record.occurredAt };
        if (
          record.tenantReference !== tenant ||
          record.brandReference !== brand ||
          record.storeReference !== store ||
          (await options.authorize(tx, query, record)) !== true
        )
          return fail();
        await fence(tx, query);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "OrderingCancellationOperation:" + brand + ":" + store + ":" + record.operationReference,
        ]);
        const prior = await tx.query(
          "SELECT " +
            selection +
            " FROM rms_ordering.order_cancellation_request_version WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
          [brand, store, record.operationReference],
        );
        if (prior.rows.length > 1) return fail();
        if (prior.rows[0]) {
          const saved = bind(prior.rows[0]);
          if (keys.some((key) => saved[key] !== record[key])) return fail();
          if ((await options.authorize(tx, query, record)) !== true) return fail();
          return Object.freeze({ status: "AlreadyCommitted" as const, record: saved });
        }
        const state = await history(tx, query),
          previous = state.records.filter(
            (item) => item.requestReference === record.requestReference,
          );
        resolveOrderCancellationRequestHistory([...previous, record]);
        if (previous.length === 0 && state.requests.some((request) => request.pending))
          return fail();
        if ((await options.validateCurrentSource(tx, record)) !== true) return fail();
        const audit = validateAuditRecord(await options.audit(record));
        const actor =
          record.status === "Requested"
            ? record.requestedByActorReference
            : record.decidedByActorReference;
        const guest =
          record.status === "Requested" && record.requestedByActorType === "GuestSession";
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.targetType !== "OrderCancellationRequest" ||
          audit.targetId !== record.requestReference ||
          audit.actionCode !== "ORDER_CANCELLATION_REQUEST_RECORDED" ||
          audit.correlationId !== record.operationReference ||
          audit.occurredAt !== record.occurredAt ||
          audit.reasonCode !== (record.decisionReasonCode ?? record.requestReasonCode) ||
          audit.beforeSummary !== undefined ||
          JSON.stringify(audit.afterSummary) !==
            JSON.stringify({ status: record.status, version: record.version }) ||
          audit.dataClassification !== "Restricted" ||
          (guest
            ? audit.actor.type !== "System"
            : audit.actor.type !== "User" || audit.actor.reference !== actor)
        )
          return fail();
        if ((await options.authorize(tx, query, record)) !== true) return fail();
        await tx.query("SAVEPOINT ordering_cancellation_append", []);
        try {
          const inserted = await tx.query(
            "INSERT INTO rms_ordering.order_cancellation_request_version (" +
              keys.map((key) => columns[key]).join(",") +
              ") VALUES (" +
              keys.map((_, i) => "$" + (i + 1)).join(",") +
              ")",
            keys.map((key) => record[key]),
          );
          if (inserted.rowCount !== 1) return fail();
          await appendAuditRecordInTransaction(tx, audit);
          await tx.query("RELEASE SAVEPOINT ordering_cancellation_append", []);
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT ordering_cancellation_append", []);
          throw error;
        }
        return Object.freeze({ status: "Committed" as const, record });
      } catch {
        return fail();
      }
    },
  });
}
