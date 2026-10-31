import {
  createOrderBatchCheckoutCancellation,
  orderBatchCheckoutCancellationReasonCodes,
  parseOrderBatchCheckoutCancellation,
  type OrderBatchCheckoutCancellationReasonCode,
} from "../../domain/order-batch-checkout-cancellation.js";
import type { OrderItemProgressFact } from "../../domain/order-item-progress.js";
import { createHash } from "node:crypto";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import { createOrderCancelledEnvelope } from "../../application/order-cancelled-event.js";
import { readClosedRecord } from "@bop/identity";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
} from "@bop/audit";
import { parseCheckoutSessionAllocation } from "../../domain/checkout-session-allocation.js";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import {
  parseOrderBatchCheckoutExpiry,
  resolveOrderBatchCheckoutExpiryHistory,
  type OrderBatchCheckoutExpiry,
} from "../../domain/order-batch-checkout-expiry.js";
const fail = (): never => {
  throw new Error("ORDER_BATCH_CHECKOUT_EXPIRY_STORE_UNAVAILABLE");
};
/**
 * WP-2423: how long a dine-in round's payment may stay unresolved after its capacity link was
 * created. The expiry candidates scan and the payment deadline read both use this one value.
 */
export const diningCheckoutPaymentWindowMinutes = 30;
const columns = {
  recordReference: "record_id",
  tenantReference: "tenant_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  orderReference: "order_id",
  orderBatchReference: "order_batch_id",
  submissionReference: "submission_id",
  commitmentReference: "commitment_id",
  paymentOperationReference: "payment_operation_id",
  version: "evidence_version",
  previousRecordReference: "previous_record_id",
  paymentRequestedAt: "payment_requested_at",
  capacityExpiresAt: "capacity_expires_at",
  observedAt: "observed_at",
  evidenceDigest: "evidence_digest",
  status: "status",
} as const;
const keys = Object.keys(columns) as (keyof typeof columns)[];
const selection =
  keys.map((key) => columns[key] + ' AS "' + key + '"').join(",") +
  ',payment_intent_id AS "paymentIntentReference",payment_attempt_id AS "paymentAttemptReference",payment_event_id AS "paymentEventReference",payment_outcome AS "outcome",terminal_occurred_at AS "terminalOccurredAt"';
const evidenceFields = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "submissionReference",
  "commitmentReference",
  "paymentOperationReference",
  "paymentRequestedAt",
  "capacityExpiresAt",
  "observedAt",
  "paymentEvidence",
] as const;
const instant = (value: unknown) =>
  parseOrderingInstant(value instanceof Date ? value.toISOString() : value);
function decode(value: unknown) {
  const row = readClosedRecord(value, [
    ...keys,
    "paymentIntentReference",
    "paymentAttemptReference",
    "paymentEventReference",
    "outcome",
    "terminalOccurredAt",
  ]);
  const fields = Object.fromEntries(keys.map((key) => [key, row[key]]));
  const terminal = [
    row.paymentIntentReference,
    row.paymentAttemptReference,
    row.paymentEventReference,
    row.outcome,
    row.terminalOccurredAt,
  ];
  if (terminal.some((v) => v === null) && !terminal.every((v) => v === null)) return fail();
  return parseOrderBatchCheckoutExpiry({
    ...fields,
    paymentRequestedAt: instant(row.paymentRequestedAt),
    capacityExpiresAt: instant(row.capacityExpiresAt),
    observedAt: instant(row.observedAt),
    paymentEvidence: terminal.every((v) => v === null)
      ? null
      : {
          paymentIntentReference: row.paymentIntentReference,
          paymentAttemptReference: row.paymentAttemptReference,
          paymentEventReference: row.paymentEventReference,
          outcome: row.outcome,
          occurredAt: instant(row.terminalOccurredAt),
        },
  });
}
interface Identity {
  orderReference: string;
  orderBatchReference: string;
}
/** Caller owns transaction rollback and retains all owner fences through commit.
 * fence acquires Payment's public receipt/order + operation fences before any
 * Ordering lock. No cancellation, refund or inventory action is performed here.
 */
export function createPostgresOrderBatchCheckoutExpiryStore(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  now(): string;
  authorize(tx: ConsumerTransaction, identity: Identity): Promise<boolean>;
  fence(tx: ConsumerTransaction, record: OrderBatchCheckoutExpiry): Promise<boolean>;
  evidence(tx: ConsumerTransaction, record: OrderBatchCheckoutExpiry): Promise<unknown>;
  audit(record: OrderBatchCheckoutExpiry): Promise<unknown>;
}) {
  const scope = {
    tenantReference: parseOrderingReference(options.tenantReference),
    brandReference: parseOrderingReference(options.brandReference),
    storeReference: parseOrderingReference(options.storeReference),
  };
  const inScope = (record: OrderBatchCheckoutExpiry) =>
    Object.entries(scope).every(([key, value]) => record[key as keyof typeof scope] === value);
  const context = (tx: ConsumerTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
  const history = async (tx: ConsumerTransaction, identity: Identity) => {
    const result = await tx.query(
      "SELECT " +
        selection +
        " FROM rms_ordering.order_batch_checkout_expiry WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND order_id=$4 AND order_batch_id=$5 ORDER BY evidence_version LIMIT 3",
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        identity.orderReference,
        identity.orderBatchReference,
      ],
    );
    if (!Array.isArray(result.rows) || result.rows.length > 2) return fail();
    const records = result.rows.map(decode);
    resolveOrderBatchCheckoutExpiryHistory(records);
    if (
      records.some(
        (r) =>
          !inScope(r) ||
          r.orderReference !== identity.orderReference ||
          r.orderBatchReference !== identity.orderBatchReference,
      )
    )
      return fail();
    return records;
  };
  return Object.freeze({
    async load(tx: ConsumerTransaction, value: unknown) {
      try {
        const raw = readClosedRecord(value, ["orderReference", "orderBatchReference"]);
        const identity = {
          orderReference: parseOrderingReference(raw.orderReference),
          orderBatchReference: parseOrderingReference(raw.orderBatchReference),
        };
        if (!(await options.authorize(tx, identity))) return fail();
        await context(tx);
        const records = await history(tx, identity);
        if (!(await options.authorize(tx, identity))) return fail();
        return Object.freeze(records);
      } catch {
        return fail();
      }
    },
    async append(tx: ConsumerTransaction, value: unknown) {
      try {
        const record = parseOrderBatchCheckoutExpiry(value),
          started = parseOrderingInstant(options.now());
        if (
          !inScope(record) ||
          record.observedAt > started ||
          !(await options.authorize(tx, record))
        )
          return fail();
        if (!(await options.fence(tx, record))) return fail();
        await context(tx);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "OrderingOrderDisposition:" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            record.orderReference,
        ]);
        const header = await tx.query(
          "SELECT order_id FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE",
          [scope.brandReference, scope.storeReference, record.orderReference],
        );
        if (header.rows.length !== 1) return fail();
        const records = await history(tx, record);
        const existing = records.find((r) => r.recordReference === record.recordReference);
        if (existing) {
          if (
            canonicalizeRfc8785(existing) !== canonicalizeRfc8785(record) ||
            !(await options.authorize(tx, record))
          )
            return fail();
          return Object.freeze({ status: "Existing" as const, record: existing });
        }
        resolveOrderBatchCheckoutExpiryHistory([...records, record]);
        const evidence = readClosedRecord(await options.evidence(tx, record), evidenceFields);
        const expected = Object.fromEntries(evidenceFields.map((key) => [key, record[key]]));
        if (
          canonicalizeRfc8785(evidence) !== canonicalizeRfc8785(expected) ||
          "sha256:" + createHash("sha256").update(canonicalizeRfc8785(evidence)).digest("hex") !==
            record.evidenceDigest
        )
          return fail();
        const audit = validateAuditRecord(await options.audit(record), Date.parse(options.now()));
        if (
          audit.brandId !== scope.brandReference ||
          audit.storeId !== scope.storeReference ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "ORDERING_BATCH_CHECKOUT_EXPIRY_RECORDED" ||
          audit.targetType !== "OrderBatch" ||
          audit.targetId !== record.orderBatchReference ||
          audit.correlationId !== record.recordReference ||
          audit.reasonCode !== "CHECKOUT_DEADLINE_REACHED" ||
          audit.occurredAt !== record.observedAt ||
          audit.sourceChannel !== "SYSTEM" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
        )
          return fail();
        const at = parseOrderingInstant(options.now());
        if (at < started || !(await options.authorize(tx, record))) return fail();
        const terminal = record.paymentEvidence;
        const values = [
          ...keys.map((key) => record[key]),
          terminal?.paymentIntentReference ?? null,
          terminal?.paymentAttemptReference ?? null,
          terminal?.paymentEventReference ?? null,
          terminal?.outcome ?? null,
          terminal?.occurredAt ?? null,
        ];
        const saved = await tx.query(
          "INSERT INTO rms_ordering.order_batch_checkout_expiry (" +
            Object.values(columns).join(",") +
            ",payment_intent_id,payment_attempt_id,payment_event_id,payment_outcome,terminal_occurred_at) VALUES (" +
            values.map((_, i) => "$" + (i + 1)).join(",") +
            ") RETURNING record_id",
          values,
        );
        if (saved.rows.length !== 1 || saved.rows[0]?.record_id !== record.recordReference)
          return fail();
        await appendAuditRecordInTransaction(tx, audit);
        return Object.freeze({ status: "Created" as const, record });
      } catch {
        return fail();
      }
    },
  });
}

/** Potential due work only. Local linkage predates the sealed Payment clock;
 * the recorder must decide actual expiry from the Dining owner, never this scan.
 */
export function createPostgresDiningCheckoutExpiryCandidates(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, observedAt: string): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async discover(transaction: ConsumerTransaction, value: unknown) {
      try {
        const raw = readClosedRecord(value, ["observedAt", "after", "limit"]);
        const at = parseOrderingInstant(raw.observedAt),
          after = raw.after === null ? null : parseOrderingReference(raw.after),
          limit = raw.limit;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          !(await options.authorize(transaction, at))
        )
          return fail();
        await transaction.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        const found = await transaction.query(
          `SELECT b.order_id AS "orderReference",b.order_batch_id AS "orderBatchReference",
          jsonb_build_object('brandReference',a.brand_id,'storeReference',a.store_id,'guestSessionReference',a.guest_session_id,
            'cartReference',a.cart_id,'cartVersion',a.cart_version,'quoteReference',a.quote_id,'quoteVersion',a.quote_version,
            'createOperationReference',a.create_operation_id,'checkoutSessionReference',a.checkout_session_id,
            'submissionReference',a.submission_id,'paymentOperationReference',a.payment_operation_id,
            'allocatedAt',to_char(a.allocated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS allocation
          FROM rms_ordering.order_batch b
          JOIN rms_ordering.order_capacity_link l ON l.brand_id=b.brand_id AND l.store_id=b.store_id
            AND l.order_id=b.order_id AND l.order_batch_id=b.order_batch_id AND l.submission_id=b.submission_id
          JOIN rms_ordering.checkout_session_allocation a ON a.brand_id=b.brand_id AND a.store_id=b.store_id
            AND a.submission_id=b.submission_id AND a.payment_operation_id=l.payment_operation_id
            AND a.cart_id=b.source_cart_id AND a.cart_version=b.source_cart_version AND a.quote_id=b.quote_id
          WHERE b.brand_id=$1 AND b.store_id=$2 AND l.link_json->>'owner'='Dining'
            AND l.created_at<=$3::timestamptz-interval '${diningCheckoutPaymentWindowMinutes} minutes' AND b.submitted_at<=$3::timestamptz
            AND a.allocated_at<=$3::timestamptz AND ($4::uuid IS NULL OR b.order_batch_id>$4::uuid)
            AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_expiry e
              WHERE e.brand_id=b.brand_id AND e.store_id=b.store_id AND e.order_batch_id=b.order_batch_id
                AND e.status<>'AwaitingPaymentResolution')
            AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c
              WHERE c.brand_id=b.brand_id AND c.store_id=b.store_id AND c.order_batch_id=b.order_batch_id)
            -- WP-2423 item 8 ⑤ decision 7: a round waiting for staff is never cancelled by time.
            AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_round_staff_hold h
              WHERE h.brand_id=b.brand_id AND h.store_id=b.store_id AND h.order_batch_id=b.order_batch_id)
          ORDER BY b.order_batch_id LIMIT $5`,
          [brand, store, at, after, limit],
        );
        if (!Array.isArray(found.rows) || found.rows.length > limit) return fail();
        let previous = after;
        const candidates = found.rows.map((value) => {
          const row = readClosedRecord(value, [
            "orderReference",
            "orderBatchReference",
            "allocation",
          ]);
          const orderReference = parseOrderingReference(row.orderReference),
            orderBatchReference = parseOrderingReference(row.orderBatchReference);
          const allocation = parseCheckoutSessionAllocation(row.allocation);
          if (
            allocation.brandReference !== brand ||
            allocation.storeReference !== store ||
            allocation.allocatedAt > at ||
            (previous !== null && orderBatchReference <= previous)
          )
            return fail();
          previous = orderBatchReference;
          return Object.freeze({ orderReference, orderBatchReference, allocation });
        });
        if (!(await options.authorize(transaction, at))) return fail();
        return Object.freeze(candidates);
      } catch {
        return fail();
      }
    },
  });
}

const cancellationColumns = {
  cancellationReference: "cancellation_id",
  operationReference: "operation_id",
  tenantReference: "tenant_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  orderReference: "order_id",
  orderBatchReference: "order_batch_id",
  submissionReference: "submission_id",
  paymentOperationReference: "payment_operation_id",
  expiryRecordReference: "expiry_record_id",
  expiryEvidenceDigest: "expiry_evidence_digest",
  expectedOrderVersion: "expected_order_version",
  cancelledOrderVersion: "cancelled_order_version",
  expectedSourceCheckpoint: "expected_source_checkpoint",
  workflowVersionReference: "workflow_version_id",
  transitionReference: "transition_id",
  orderItemReferences: "order_item_ids",
  cancelledAt: "cancelled_at",
  phase: "phase",
  reasonCode: "reason_code",
} as const;
type Cancellation = ReturnType<typeof parseOrderBatchCheckoutCancellation>;
/** sha256 of the canonical cancellation record (the `OrderCancelled` source digest). */
export function orderBatchCheckoutCancellationDigest(record: Cancellation): string {
  const canonical = parseOrderBatchCheckoutCancellation(record);
  return "sha256:" + createHash("sha256").update(canonicalizeRfc8785(canonical)).digest("hex");
}
/** Caller must retain the Payment fence and roll back the entire transaction on error. */
export function createPostgresOrderBatchCheckoutCancellationStore(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  now(): string;
  authorize(tx: ConsumerTransaction, record: Cancellation): Promise<boolean>;
  fence(tx: ConsumerTransaction, record: Cancellation): Promise<boolean>;
  source(
    tx: ConsumerTransaction,
    record: Cancellation,
  ): Promise<{
    expiry: unknown;
    items: readonly (OrderItemProgressFact & { orderBatchReference: string })[];
    orderVersion: number;
    checkpoint: string;
  }>;
  workflow(tx: ConsumerTransaction, record: Cancellation): Promise<boolean>;
  audit(record: Cancellation): Promise<unknown>;
  /** WP-2423: the new `OrderCancelled` event's reference, published in this transaction. */
  eventReference(record: Cancellation): string;
}) {
  const scope = {
    tenantReference: parseOrderingReference(options.tenantReference),
    brandReference: parseOrderingReference(options.brandReference),
    storeReference: parseOrderingReference(options.storeReference),
  };
  const names = Object.keys(cancellationColumns) as (keyof typeof cancellationColumns)[];
  const selection = names.map((key) => cancellationColumns[key] + ' AS "' + key + '"').join(",");
  return Object.freeze({
    async append(tx: ConsumerTransaction, value: unknown) {
      try {
        const record = parseOrderBatchCheckoutCancellation(value),
          started = parseOrderingInstant(options.now());
        if (
          record.tenantReference !== scope.tenantReference ||
          record.brandReference !== scope.brandReference ||
          record.storeReference !== scope.storeReference ||
          record.cancelledAt > started ||
          !(await options.authorize(tx, record))
        )
          return fail();
        if (!(await options.fence(tx, record))) return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "OrderingOrderDisposition:" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            record.orderReference,
        ]);
        const header = await tx.query(
          "SELECT order_id FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_type='DineIn' FOR UPDATE",
          [scope.brandReference, scope.storeReference, record.orderReference],
        );
        if (header.rows.length !== 1) return fail();
        const previous = await tx.query(
          "SELECT " +
            selection +
            " FROM rms_ordering.order_batch_checkout_cancellation WHERE brand_id=$1 AND store_id=$2 AND (operation_id=$3 OR order_batch_id=$4) LIMIT 2",
          [
            scope.brandReference,
            scope.storeReference,
            record.operationReference,
            record.orderBatchReference,
          ],
        );
        if (previous.rows.length > 0) {
          if (previous.rows.length !== 1) return fail();
          const row = previous.rows[0];
          const existing = parseOrderBatchCheckoutCancellation({
            ...row,
            cancelledAt:
              row?.cancelledAt instanceof Date ? row.cancelledAt.toISOString() : row?.cancelledAt,
          });
          if (
            canonicalizeRfc8785(existing) !== canonicalizeRfc8785(record) ||
            !(await options.authorize(tx, record))
          )
            return fail();
          return Object.freeze({ status: "Existing" as const, record: existing });
        }
        const source = await options.source(tx, record);
        if (
          source.orderVersion !== record.expectedOrderVersion ||
          source.checkpoint !== record.expectedSourceCheckpoint
        )
          return fail();
        createOrderBatchCheckoutCancellation({
          record,
          expiry: source.expiry,
          items: source.items,
        });
        if (!(await options.workflow(tx, record))) return fail();
        const audit = validateAuditRecord(await options.audit(record), Date.parse(options.now()));
        if (
          audit.brandId !== scope.brandReference ||
          audit.storeId !== scope.storeReference ||
          // WP-2423 abandoned payment: a manager's cancellation before the deadline names them.
          (record.reasonCode === "STAFF_CANCELLED_UNPAID"
            ? audit.actor.type !== "User" || audit.sourceChannel !== "MERCHANT_WEB"
            : audit.actor.type !== "System" || audit.sourceChannel !== "SYSTEM") ||
          audit.actionCode !== "ORDERING_BATCH_CHECKOUT_CANCELLED" ||
          audit.targetType !== "OrderBatch" ||
          audit.targetId !== record.orderBatchReference ||
          audit.correlationId !== record.operationReference ||
          audit.reasonCode !== record.reasonCode ||
          audit.occurredAt !== record.cancelledAt ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          // WP-2423 abandoned payment: a manager's cancellation after the card provider could not
          // confirm the round's online payment says so (they checked with the guest).
          (audit.afterSummary !== undefined &&
            (record.reasonCode !== "STAFF_CANCELLED_UNPAID" ||
              JSON.stringify(audit.afterSummary) !==
                JSON.stringify({ providerPaymentUnconfirmed: true })))
        )
          return fail();
        if (parseOrderingInstant(options.now()) < started || !(await options.authorize(tx, record)))
          return fail();
        const saved = await tx.query(
          "INSERT INTO rms_ordering.order_batch_checkout_cancellation (" +
            names.map((key) => cancellationColumns[key]).join(",") +
            ") VALUES (" +
            names.map((_, i) => "$" + (i + 1)).join(",") +
            ") RETURNING cancellation_id",
          names.map((key) => record[key]),
        );
        if (
          saved.rows.length !== 1 ||
          saved.rows[0]?.cancellation_id !== record.cancellationReference
        )
          return fail();
        const revision = await tx.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'BatchCancellation',$5,$6,$7,NULL,$8) RETURNING revision_id",
          [
            record.cancellationReference,
            scope.brandReference,
            scope.storeReference,
            record.orderReference,
            record.cancelledOrderVersion,
            record.expectedOrderVersion,
            record.expectedSourceCheckpoint,
            record.cancelledAt,
          ],
        );
        if (
          revision.rows.length !== 1 ||
          revision.rows[0]?.revision_id !== record.cancellationReference
        )
          return fail();
        await appendAuditRecordInTransaction(tx, audit);
        // WP-2423: consumers learn of the cancellation from the Order's own event, in order with
        // the Order's other events (aggregate version = the cancelled Order version).
        await appendEventInTransaction(
          tx,
          createOrderCancelledEnvelope({
            eventReference: parseOrderingReference(options.eventReference(record)),
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            operationReference: record.operationReference,
            cancelledOrderVersion: record.cancelledOrderVersion,
            payload: {
              orderReference: record.orderReference,
              orderBatchReference: record.orderBatchReference,
              cancellationReference: record.cancellationReference,
              cancellationScope: "Batch",
              reasonCode: record.reasonCode,
              itemCount: record.orderItemReferences.length,
              cancelledAt: record.cancelledAt,
              sourceDigest: orderBatchCheckoutCancellationDigest(record),
            },
          }),
        );
        if (!(await options.authorize(tx, record))) return fail();
        return Object.freeze({ status: "Created" as const, record });
      } catch {
        return fail();
      }
    },
  });
}

/** Historical operation recovery, not permission to create a replacement operation.
 * Retain the caller's Payment fence if a missing result will precede a write.
 */
export function createPostgresOrderBatchCheckoutCancellationReader(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  now(): string;
  authorize(
    tx: ConsumerTransaction,
    identity: { orderReference: string; orderBatchReference: string; operationReference: string },
  ): Promise<boolean>;
}) {
  const scope = {
    tenantReference: parseOrderingReference(options.tenantReference),
    brandReference: parseOrderingReference(options.brandReference),
    storeReference: parseOrderingReference(options.storeReference),
  };
  const keys = Object.keys(cancellationColumns) as (keyof typeof cancellationColumns)[];
  const selection = keys.map((key) => cancellationColumns[key] + ' AS "' + key + '"').join(",");
  return Object.freeze({
    async loadOperation(tx: ConsumerTransaction, value: unknown) {
      try {
        const raw = readClosedRecord(value, [
          "orderReference",
          "orderBatchReference",
          "operationReference",
        ]);
        const identity = {
          orderReference: parseOrderingReference(raw.orderReference),
          orderBatchReference: parseOrderingReference(raw.orderBatchReference),
          operationReference: parseOrderingReference(raw.operationReference),
        };
        const at = parseOrderingInstant(options.now());
        if (!(await options.authorize(tx, identity))) return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const result = await tx.query(
          "SELECT " +
            selection +
            " FROM rms_ordering.order_batch_checkout_cancellation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3 LIMIT 2",
          [scope.brandReference, scope.storeReference, identity.operationReference],
        );
        if (
          result.rows.length > 1 ||
          parseOrderingInstant(options.now()) < at ||
          !(await options.authorize(tx, identity))
        )
          return fail();
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        const record = parseOrderBatchCheckoutCancellation({
          ...row,
          cancelledAt:
            row?.cancelledAt instanceof Date ? row.cancelledAt.toISOString() : row?.cancelledAt,
        });
        if (
          record.tenantReference !== scope.tenantReference ||
          record.brandReference !== scope.brandReference ||
          record.storeReference !== scope.storeReference ||
          record.orderReference !== identity.orderReference ||
          record.orderBatchReference !== identity.orderBatchReference ||
          record.operationReference !== identity.operationReference ||
          record.cancelledAt > at
        )
          return fail();
        return record;
      } catch {
        return fail();
      }
    },
  });
}

/** Discovery only. A subsequent cancellation must reread complete history and owner facts
 * under Payment fences; a scan result never authorizes a cancellation.
 */
export function createPostgresDiningBatchCancellationCandidates(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  authorize(tx: ConsumerTransaction, observedAt: string): Promise<boolean>;
}) {
  const tenant = parseOrderingReference(options.tenantReference),
    brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async discover(tx: ConsumerTransaction, value: unknown) {
      try {
        const raw = readClosedRecord(value, ["observedAt", "after", "limit"]),
          at = parseOrderingInstant(raw.observedAt),
          after = raw.after === null ? null : parseOrderingReference(raw.after),
          limit = raw.limit;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          !(await options.authorize(tx, at))
        )
          return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        // WP-2423: a round whose payment failed, or whose payment was still unresolved when its window
        // ended (the cancellation proves from Payment that none was ever started, or skips it), of an
        // Order that is still open and a round nobody accepted or cancelled.
        const found = await tx.query(
          `SELECT ${selection} FROM rms_ordering.order_batch_checkout_expiry e
    WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.store_id=$3
      AND e.status IN ('PaymentFailed','AwaitingPaymentResolution')
      AND e.observed_at<=$4::timestamptz AND ($5::uuid IS NULL OR e.record_id>$5::uuid)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t
        WHERE t.brand_id=e.brand_id AND t.store_id=e.store_id AND t.order_id=e.order_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a
        WHERE a.brand_id=e.brand_id AND a.store_id=e.store_id AND a.order_id=e.order_id AND a.order_batch_id=e.order_batch_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation s
        WHERE s.brand_id=e.brand_id AND s.store_id=e.store_id AND s.order_id=e.order_id AND s.order_batch_id=e.order_batch_id)
      AND COALESCE((SELECT v.status FROM rms_ordering.order_closure_version v
        WHERE v.brand_id=e.brand_id AND v.store_id=e.store_id AND v.order_id=e.order_id
        ORDER BY v.closure_version DESC LIMIT 1),'Open')<>'Closed'
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_expiry later
        WHERE later.tenant_id=e.tenant_id AND later.brand_id=e.brand_id AND later.store_id=e.store_id
          AND later.order_batch_id=e.order_batch_id AND later.evidence_version>e.evidence_version)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c
        WHERE c.tenant_id=e.tenant_id AND c.brand_id=e.brand_id AND c.store_id=e.store_id AND c.order_batch_id=e.order_batch_id)
    ORDER BY e.record_id LIMIT $6`,
          [tenant, brand, store, at, after, limit],
        );
        if (!Array.isArray(found.rows) || found.rows.length > limit) return fail();
        let previous = after;
        const batches = new Set<string>();
        const result = found.rows.map((row) => {
          const record = decode(row);
          if (
            record.tenantReference !== tenant ||
            record.brandReference !== brand ||
            record.storeReference !== store ||
            (record.status !== "PaymentFailed" && record.status !== "AwaitingPaymentResolution") ||
            record.observedAt > at ||
            (previous !== null && record.recordReference <= previous) ||
            batches.has(record.orderBatchReference)
          )
            return fail();
          previous = record.recordReference;
          batches.add(record.orderBatchReference);
          return record;
        });
        if (!(await options.authorize(tx, at))) return fail();
        return Object.freeze(result);
      } catch {
        return fail();
      }
    },
  });
}

interface StoreScope {
  readonly brandReference: string;
  readonly storeReference: string;
}
const orderList = (orderReferences: readonly string[]) => {
  if (orderReferences.length > 100) return fail();
  return orderReferences.map((reference) => parseOrderingReference(reference));
};
const storeContext = (transaction: ConsumerTransaction, scope: StoreScope) =>
  transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [parseOrderingReference(scope.brandReference), parseOrderingReference(scope.storeReference)],
  );

/**
 * WP-2423: when each Dining-owned round of the given Orders stops waiting for payment (its capacity
 * link plus the dining payment window). A round whose payment failed is cancelled automatically
 * once this passes; staff and the customer are told the time before it happens. Read only; the
 * caller authorizes and owns the transaction.
 */
export async function listStoreDiningBatchPaymentDeadlines(
  transaction: ConsumerTransaction,
  scope: StoreScope,
  orderReferences: readonly string[],
): Promise<
  readonly {
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly paymentDeadline: string;
  }[]
> {
  const orders = orderList(orderReferences);
  if (orders.length === 0) return Object.freeze([]);
  await storeContext(transaction, scope);
  const found = await transaction.query(
    `SELECT l.order_id::text AS "orderReference",l.order_batch_id::text AS "orderBatchReference",
      to_char((l.created_at+interval '${diningCheckoutPaymentWindowMinutes} minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "paymentDeadline"
    FROM rms_ordering.order_capacity_link l
    WHERE l.brand_id=$1 AND l.store_id=$2 AND l.order_id=ANY($3::uuid[]) AND l.link_json->>'owner'='Dining'
    ORDER BY l.order_batch_id LIMIT 10001`,
    [
      parseOrderingReference(scope.brandReference),
      parseOrderingReference(scope.storeReference),
      orders,
    ],
  );
  if (!Array.isArray(found.rows) || found.rows.length > 10000) return fail();
  const seen = new Set<string>();
  return Object.freeze(
    found.rows.map((value) => {
      const row = readClosedRecord(value, [
        "orderReference",
        "orderBatchReference",
        "paymentDeadline",
      ]);
      const orderReference = parseOrderingReference(row.orderReference),
        orderBatchReference = parseOrderingReference(row.orderBatchReference);
      if (!orders.includes(orderReference) || seen.has(orderBatchReference)) return fail();
      seen.add(orderBatchReference);
      return Object.freeze({
        orderReference,
        orderBatchReference,
        paymentDeadline: parseOrderingInstant(row.paymentDeadline),
      });
    }),
  );
}

/**
 * WP-2423 item 3: when a Dining-owned round's payment window started, for a round whose Dining
 * checkout commitment never requested payment (the guest's browser closed between the round being
 * submitted and payment being requested). The window starts at the later of the round's submission
 * and its capacity link, rounded up to the stored millisecond, so the window never ends before the
 * deadline staff and the guest were shown. Null when no such Dining-owned round exists. Read only;
 * the caller authorizes, owns the transaction and holds the payment operation fence.
 */
export async function loadDiningBatchPaymentWindowStart(
  transaction: ConsumerTransaction,
  scope: StoreScope,
  value: unknown,
): Promise<string | null> {
  const raw = readClosedRecord(value, [
    "orderReference",
    "orderBatchReference",
    "submissionReference",
    "commitmentReference",
    "paymentOperationReference",
  ]);
  const identity = [
    raw.orderReference,
    raw.orderBatchReference,
    raw.submissionReference,
    raw.commitmentReference,
    raw.paymentOperationReference,
  ].map((reference) => parseOrderingReference(reference));
  await storeContext(transaction, scope);
  const found = await transaction.query(
    `SELECT to_char(CASE WHEN date_trunc('milliseconds',s.at)<s.at
        THEN date_trunc('milliseconds',s.at)+interval '1 millisecond' ELSE s.at END AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "windowStartsAt"
    FROM (SELECT GREATEST(b.submitted_at,l.created_at) AS at
      FROM rms_ordering.order_batch b
      JOIN rms_ordering.order_capacity_link l ON l.brand_id=b.brand_id AND l.store_id=b.store_id
        AND l.order_id=b.order_id AND l.order_batch_id=b.order_batch_id AND l.submission_id=b.submission_id
      WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 AND b.order_batch_id=$4
        AND b.submission_id=$5 AND l.commitment_id=$6 AND l.payment_operation_id=$7
        AND l.link_json->>'owner'='Dining') s
    LIMIT 2`,
    [
      parseOrderingReference(scope.brandReference),
      parseOrderingReference(scope.storeReference),
      ...identity,
    ],
  );
  if (!Array.isArray(found.rows) || found.rows.length > 1) return fail();
  if (found.rows.length === 0) return null;
  const row = readClosedRecord(found.rows[0], ["windowStartsAt"]);
  return parseOrderingInstant(row.windowStartsAt);
}

/**
 * WP-2423: dine-in rounds of the given Orders the System cancelled because their payment failed
 * and the payment window ended (never charged). Read only; the caller authorizes.
 */
export async function listStoreUnpaidBatchCancellations(
  transaction: ConsumerTransaction,
  scope: StoreScope,
  orderReferences: readonly string[],
): Promise<
  readonly {
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly cancelledAt: string;
    /** WP-2423 abandoned payment: why (a manager's cancellation reads differently to staff). */
    readonly reasonCode: OrderBatchCheckoutCancellationReasonCode;
  }[]
> {
  const orders = orderList(orderReferences);
  if (orders.length === 0) return Object.freeze([]);
  await storeContext(transaction, scope);
  const found = await transaction.query(
    `SELECT c.order_id::text AS "orderReference",c.order_batch_id::text AS "orderBatchReference",c.cancelled_at AS "cancelledAt",c.reason_code AS "reasonCode"
    FROM rms_ordering.order_batch_checkout_cancellation c
    WHERE c.brand_id=$1 AND c.store_id=$2 AND c.order_id=ANY($3::uuid[])
    ORDER BY c.order_batch_id LIMIT 10001`,
    [
      parseOrderingReference(scope.brandReference),
      parseOrderingReference(scope.storeReference),
      orders,
    ],
  );
  if (!Array.isArray(found.rows) || found.rows.length > 10000) return fail();
  const seen = new Set<string>();
  return Object.freeze(
    found.rows.map((value) => {
      const row = readClosedRecord(value, [
        "orderReference",
        "orderBatchReference",
        "cancelledAt",
        "reasonCode",
      ]);
      if (
        !(orderBatchCheckoutCancellationReasonCodes as readonly unknown[]).includes(row.reasonCode)
      )
        return fail();
      const orderReference = parseOrderingReference(row.orderReference),
        orderBatchReference = parseOrderingReference(row.orderBatchReference);
      if (!orders.includes(orderReference) || seen.has(orderBatchReference)) return fail();
      seen.add(orderBatchReference);
      return Object.freeze({
        orderReference,
        orderBatchReference,
        cancelledAt: instant(row.cancelledAt),
        reasonCode: row.reasonCode as OrderBatchCheckoutCancellationReasonCode,
      });
    }),
  );
}

/**
 * WP-2423: one System round cancellation by its reference (the `OrderCancelled` source), or null.
 * Read only; the caller authorizes and owns the transaction.
 */
export async function loadOrderBatchCheckoutCancellation(
  transaction: ConsumerTransaction,
  scope: StoreScope,
  cancellationReference: string,
): Promise<Cancellation | null> {
  await storeContext(transaction, scope);
  const names = Object.keys(cancellationColumns) as (keyof typeof cancellationColumns)[];
  const found = await transaction.query(
    "SELECT " +
      names.map((key) => cancellationColumns[key] + ' AS "' + key + '"').join(",") +
      " FROM rms_ordering.order_batch_checkout_cancellation WHERE brand_id=$1 AND store_id=$2 AND cancellation_id=$3 LIMIT 2",
    [
      parseOrderingReference(scope.brandReference),
      parseOrderingReference(scope.storeReference),
      parseOrderingReference(cancellationReference),
    ],
  );
  if (!Array.isArray(found.rows) || found.rows.length > 1) return fail();
  const row = found.rows[0];
  if (row === undefined) return null;
  return parseOrderBatchCheckoutCancellation({
    ...row,
    cancelledAt: instant(row.cancelledAt),
  });
}

/** WP-2423: whether an `OrderCancelled` event states exactly this stored cancellation. */
export async function orderCancelledEventMatchesRecord(
  transaction: ConsumerTransaction,
  scope: StoreScope,
  event: {
    readonly aggregateId: string;
    readonly aggregateVersion: bigint;
    readonly payload: {
      readonly orderReference: string;
      readonly orderBatchReference: string;
      readonly cancellationReference: string;
      readonly reasonCode: string;
      readonly itemCount: number;
      readonly cancelledAt: string;
      readonly sourceDigest: string;
    };
  },
): Promise<boolean> {
  const record = await loadOrderBatchCheckoutCancellation(
    transaction,
    scope,
    event.payload.cancellationReference,
  );
  return (
    record !== null &&
    record.orderReference === event.aggregateId &&
    record.orderReference === event.payload.orderReference &&
    record.orderBatchReference === event.payload.orderBatchReference &&
    BigInt(record.cancelledOrderVersion) === event.aggregateVersion &&
    record.reasonCode === event.payload.reasonCode &&
    record.orderItemReferences.length === event.payload.itemCount &&
    record.cancelledAt === event.payload.cancelledAt &&
    orderBatchCheckoutCancellationDigest(record) === event.payload.sourceDigest
  );
}

/**
 * WP-2423 abandoned payment: the payment identity of one Dining-owned round (its submission, Dining
 * checkout commitment and payment operation), for a manager's cancellation of the unpaid round
 * before its deadline. Null when the round is not Dining-owned. Read only; the caller authorizes,
 * owns the transaction and takes the payment operation fence before acting on it.
 */
export async function loadDiningRoundPaymentIdentity(
  transaction: ConsumerTransaction,
  scope: StoreScope,
  value: { readonly orderReference: string; readonly orderBatchReference: string },
): Promise<null | {
  readonly submissionReference: string;
  readonly commitmentReference: string;
  readonly paymentOperationReference: string;
}> {
  const orderReference = parseOrderingReference(value.orderReference),
    orderBatchReference = parseOrderingReference(value.orderBatchReference);
  await storeContext(transaction, scope);
  const found = await transaction.query(
    `SELECT b.submission_id::text AS "submissionReference",l.commitment_id::text AS "commitmentReference",
      l.payment_operation_id::text AS "paymentOperationReference"
    FROM rms_ordering.order_batch b
    JOIN rms_ordering.order_capacity_link l ON l.brand_id=b.brand_id AND l.store_id=b.store_id
      AND l.order_id=b.order_id AND l.order_batch_id=b.order_batch_id AND l.submission_id=b.submission_id
    JOIN rms_ordering.order_header h ON h.brand_id=b.brand_id AND h.store_id=b.store_id
      AND h.order_id=b.order_id AND h.order_type='DineIn'
    WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 AND b.order_batch_id=$4
      AND l.link_json->>'owner'='Dining'
    LIMIT 2`,
    [
      parseOrderingReference(scope.brandReference),
      parseOrderingReference(scope.storeReference),
      orderReference,
      orderBatchReference,
    ],
  );
  if (!Array.isArray(found.rows) || found.rows.length > 1) return fail();
  if (found.rows.length === 0) return null;
  const row = readClosedRecord(found.rows[0], [
    "submissionReference",
    "commitmentReference",
    "paymentOperationReference",
  ]);
  return Object.freeze({
    submissionReference: parseOrderingReference(row.submissionReference),
    commitmentReference: parseOrderingReference(row.commitmentReference),
    paymentOperationReference: parseOrderingReference(row.paymentOperationReference),
  });
}

/**
 * WP-2423 abandoned payment ("warn before timeouts" on Tables): the guest-ordered dine-in rounds of
 * these dining sessions that nobody has paid for yet — not accepted, not cancelled, no payment
 * recorded by Ordering — with when each is cancelled automatically unless paid (its capacity link
 * plus the dining payment window). Staff-entered rounds are listed by their own read. One query for
 * every session on the page. Read only; the caller authorizes and owns the transaction.
 */
export async function listStoreUnpaidGuestDiningRounds(
  transaction: ConsumerTransaction,
  scope: StoreScope,
  diningSessionReferences: readonly string[],
): Promise<
  readonly {
    readonly diningSessionReference: string;
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly roundNumber: number;
    readonly payBy: string;
  }[]
> {
  if (diningSessionReferences.length > 100) return fail();
  if (diningSessionReferences.length === 0) return Object.freeze([]);
  const sessions = diningSessionReferences.map((reference) => parseOrderingReference(reference));
  await storeContext(transaction, scope);
  const found = await transaction.query(
    `SELECT r.dining_session_id::text AS "diningSessionReference",r.order_id::text AS "orderReference",
      r.order_batch_id::text AS "orderBatchReference",r.round_number::integer AS "roundNumber",
      to_char((l.created_at+interval '${diningCheckoutPaymentWindowMinutes} minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "payBy"
    FROM (SELECT h.dining_session_id,b.brand_id,b.store_id,b.order_id,b.order_batch_id,b.submission_id,
        row_number() OVER (PARTITION BY b.order_id ORDER BY b.submitted_at,b.order_batch_id) AS round_number
      FROM rms_ordering.order_header h
      JOIN rms_ordering.order_batch b ON b.brand_id=h.brand_id AND b.store_id=h.store_id AND b.order_id=h.order_id
      WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_type='DineIn' AND h.dining_session_id=ANY($3::uuid[])) r
    JOIN rms_ordering.order_capacity_link l ON l.brand_id=r.brand_id AND l.store_id=r.store_id
      AND l.order_id=r.order_id AND l.order_batch_id=r.order_batch_id AND l.submission_id=r.submission_id
      AND l.link_json->>'owner'='Dining'
    WHERE NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=r.brand_id
        AND a.store_id=r.store_id AND a.order_id=r.order_id AND a.order_batch_id=r.order_batch_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c WHERE c.brand_id=r.brand_id
        AND c.store_id=r.store_id AND c.order_batch_id=r.order_batch_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation s WHERE s.brand_id=r.brand_id
        AND s.store_id=r.store_id AND s.order_id=r.order_id AND s.order_batch_id=r.order_batch_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_acceptance_wait w WHERE w.brand_id=r.brand_id
        AND w.store_id=r.store_id AND w.order_id=r.order_id AND w.order_batch_id=r.order_batch_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=r.brand_id
        AND d.store_id=r.store_id AND d.order_id=r.order_id AND d.order_batch_id=r.order_batch_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=r.brand_id
        AND t.store_id=r.store_id AND t.order_id=r.order_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.checkout_session_allocation a
        JOIN rms_ordering.staff_dining_round_entry e ON e.brand_id=a.brand_id AND e.store_id=a.store_id
          AND e.guest_session_id=a.guest_session_id
        WHERE a.brand_id=r.brand_id AND a.store_id=r.store_id AND a.submission_id=r.submission_id)
    ORDER BY r.order_id,r.round_number LIMIT 201`,
    [
      parseOrderingReference(scope.brandReference),
      parseOrderingReference(scope.storeReference),
      sessions,
    ],
  );
  if (!Array.isArray(found.rows) || found.rows.length > 200) return fail();
  return Object.freeze(
    found.rows.map((value) => {
      const row = readClosedRecord(value, [
        "diningSessionReference",
        "orderReference",
        "orderBatchReference",
        "roundNumber",
        "payBy",
      ]);
      const diningSessionReference = parseOrderingReference(row.diningSessionReference);
      if (
        !sessions.includes(diningSessionReference) ||
        typeof row.roundNumber !== "number" ||
        !Number.isSafeInteger(row.roundNumber) ||
        row.roundNumber < 1
      )
        return fail();
      return Object.freeze({
        diningSessionReference,
        orderReference: parseOrderingReference(row.orderReference),
        orderBatchReference: parseOrderingReference(row.orderBatchReference),
        roundNumber: row.roundNumber,
        payBy: parseOrderingInstant(row.payBy),
      });
    }),
  );
}

/**
 * WP-2423 (v15 2026-10-16): paid guest rounds of the given dining sessions that staff have not
 * accepted yet — Ordering recorded the payment as awaiting acceptance and nothing disposed of it
 * (no acceptance, disposition, staff cancellation or Order termination). A paid dine-in round is
 * never refunded automatically, so the Tables page warns staff while it waits; `paidAt` is when
 * Ordering recorded the payment. Caller authorizes the Store and owns the transaction.
 */
export async function listStorePaidDiningRoundsAwaitingAcceptance(
  transaction: ConsumerTransaction,
  scope: StoreScope,
  diningSessionReferences: readonly string[],
): Promise<
  readonly {
    readonly diningSessionReference: string;
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly roundNumber: number;
    readonly paidAt: string;
  }[]
> {
  if (diningSessionReferences.length > 100) return fail();
  if (diningSessionReferences.length === 0) return Object.freeze([]);
  const sessions = diningSessionReferences.map((reference) => parseOrderingReference(reference));
  await storeContext(transaction, scope);
  const found = await transaction.query(
    `SELECT r.dining_session_id::text AS "diningSessionReference",r.order_id::text AS "orderReference",
      r.order_batch_id::text AS "orderBatchReference",r.round_number::integer AS "roundNumber",
      to_char(w.evaluated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "paidAt"
    FROM (SELECT h.dining_session_id,b.brand_id,b.store_id,b.order_id,b.order_batch_id,
        row_number() OVER (PARTITION BY b.order_id ORDER BY b.submitted_at,b.order_batch_id) AS round_number
      FROM rms_ordering.order_header h
      JOIN rms_ordering.order_batch b ON b.brand_id=h.brand_id AND b.store_id=h.store_id AND b.order_id=h.order_id
      WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_type='DineIn' AND h.dining_session_id=ANY($3::uuid[])) r
    JOIN rms_ordering.order_payment_acceptance_wait w ON w.brand_id=r.brand_id AND w.store_id=r.store_id
      AND w.order_id=r.order_id AND w.order_batch_id=r.order_batch_id
    WHERE NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=r.brand_id
        AND a.store_id=r.store_id AND a.order_id=r.order_id AND a.order_batch_id=r.order_batch_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=r.brand_id
        AND d.store_id=r.store_id AND d.order_id=r.order_id AND d.order_batch_id=r.order_batch_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation s WHERE s.brand_id=r.brand_id
        AND s.store_id=r.store_id AND s.order_id=r.order_id AND s.order_batch_id=r.order_batch_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=r.brand_id
        AND t.store_id=r.store_id AND t.order_id=r.order_id)
    ORDER BY r.order_id,r.round_number LIMIT 201`,
    [
      parseOrderingReference(scope.brandReference),
      parseOrderingReference(scope.storeReference),
      sessions,
    ],
  );
  if (!Array.isArray(found.rows) || found.rows.length > 200) return fail();
  return Object.freeze(
    found.rows.map((value) => {
      const row = readClosedRecord(value, [
        "diningSessionReference",
        "orderReference",
        "orderBatchReference",
        "roundNumber",
        "paidAt",
      ]);
      const diningSessionReference = parseOrderingReference(row.diningSessionReference);
      if (
        !sessions.includes(diningSessionReference) ||
        typeof row.roundNumber !== "number" ||
        !Number.isSafeInteger(row.roundNumber) ||
        row.roundNumber < 1
      )
        return fail();
      return Object.freeze({
        diningSessionReference,
        orderReference: parseOrderingReference(row.orderReference),
        orderBatchReference: parseOrderingReference(row.orderBatchReference),
        roundNumber: row.roundNumber,
        paidAt: parseOrderingInstant(row.paidAt),
      });
    }),
  );
}
