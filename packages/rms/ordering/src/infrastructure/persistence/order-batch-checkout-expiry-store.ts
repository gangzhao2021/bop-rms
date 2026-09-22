import {
  createOrderBatchCheckoutCancellation,
  parseOrderBatchCheckoutCancellation,
} from "../../domain/order-batch-checkout-cancellation.js";
import type { OrderItemProgressFact } from "../../domain/order-item-progress.js";
import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
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
            AND l.created_at<=$3::timestamptz-interval '30 minutes' AND b.submitted_at<=$3::timestamptz
            AND a.allocated_at<=$3::timestamptz AND ($4::uuid IS NULL OR b.order_batch_id>$4::uuid)
            AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_expiry e
              WHERE e.brand_id=b.brand_id AND e.store_id=b.store_id AND e.order_batch_id=b.order_batch_id
                AND e.status<>'AwaitingPaymentResolution')
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
          audit.actor.type !== "System" ||
          audit.actionCode !== "ORDERING_BATCH_CHECKOUT_CANCELLED" ||
          audit.targetType !== "OrderBatch" ||
          audit.targetId !== record.orderBatchReference ||
          audit.correlationId !== record.operationReference ||
          audit.reasonCode !== record.reasonCode ||
          audit.occurredAt !== record.cancelledAt ||
          audit.sourceChannel !== "SYSTEM" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
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
        const found = await tx.query(
          `SELECT ${selection} FROM rms_ordering.order_batch_checkout_expiry e
    WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.store_id=$3 AND e.status='PaymentFailed'
      AND e.observed_at<=$4::timestamptz AND ($5::uuid IS NULL OR e.record_id>$5::uuid)
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
            record.status !== "PaymentFailed" ||
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
