import { parseOrderingReference } from "../../domain/cart.js";
import {
  OrderCreationError,
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  type OrderCreationRecord,
} from "../../domain/order-creation.js";
import {
  decodeOrderItemSnapshot,
  decodeConfiguredOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";

export interface OrderCreationQueryTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface OrderCreationQueryTransactionRunner {
  /** Dedicated bounded transaction; commit on success, rollback on error, always clear context/release. */
  run<T>(action: (transaction: OrderCreationQueryTransaction) => Promise<T>): Promise<T>;
}

const selectHistory = `SELECT jsonb_build_object('record', jsonb_build_object('submissionReference', s.submission_id,
'submissionIntentHash', s.intent_digest,
'guestSessionReference', s.guest_session_id,
'order', jsonb_build_object('orderReference', h.order_id,
'brandReference', h.brand_id,
'storeReference', h.store_id,
'orderType', h.order_type,
'sourceChannel', h.source_channel,
'diningSessionReference', h.dining_session_id,
'createdByActorReference', h.created_by_actor_id,
'submittedByActorReference', h.submitted_by_actor_id,
'aggregateVersion', h.aggregate_version,
'canonicalPhase', h.canonical_phase,
'closureStatus', h.closure_status,
'paymentStatus', h.payment_status,
'createdAt', CASE WHEN h.created_at = date_trunc('milliseconds', h.created_at) THEN to_char(h.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
'batches', jsonb_build_array(jsonb_build_object('orderBatchReference', b.order_batch_id,
'orderReference', b.order_id,
'submissionReference', b.submission_id,
'sourceCartReference', b.source_cart_id,
'sourceCartVersion', b.source_cart_version,
'checkoutValidationReference', b.checkout_validation_id,
'quoteReference', b.quote_id,
'submittedByActorReference', b.submitted_by_actor_id,
'submittedAt', CASE WHEN b.submitted_at = date_trunc('milliseconds', b.submitted_at) THEN to_char(b.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
'items', '[]'::jsonb))),
'items', '[]'::jsonb,
'orderNumberAllocation', jsonb_build_object('orderReference', n.order_id,
'brandReference', n.brand_id,
'storeReference', n.store_id,
'businessDate', n.business_date::text,
'sequence', n.sequence::text,
'orderNumber', n.order_number,
'allocatedAt', CASE WHEN n.allocated_at = date_trunc('milliseconds', n.allocated_at) THEN to_char(n.allocated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
'businessDateResolution', jsonb_build_object('brandReference', n.brand_id,
'storeReference', n.store_id,
'occurredAt', CASE WHEN n.allocated_at = date_trunc('milliseconds', n.allocated_at) THEN to_char(n.allocated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
'businessDate', n.business_date::text,
'businessDateBoundaryAt', CASE WHEN n.business_date_boundary_at = date_trunc('milliseconds', n.business_date_boundary_at) THEN to_char(n.business_date_boundary_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
'boundaryDisambiguation', n.boundary_disambiguation,
'configurationReference', n.business_date_configuration_id,
'configurationVersion', n.business_date_configuration_version,
'contentDigest', n.business_date_content_digest,
'timeZone', n.time_zone,
'businessDayStartLocalTime', n.business_day_start::text)),
'createdAt', CASE WHEN s.created_at = date_trunc('milliseconds', s.created_at) THEN to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END),
'source', jsonb_build_object('cart', s.source_cart_id,
'version', s.source_cart_version,
'quote', s.quote_id,
'businessDate', h.business_date::text,
'orderNumber', h.order_number),
'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
'ordinal', i.ordinal, 'orderItemReference', i.order_item_id,
'orderBatchReference', i.order_batch_id, 'cartItemReference', i.source_cart_line_id,
'quantity', i.quantity, 'catalogDigest', i.catalog_snapshot_digest,
'quoteDigest', i.quote_input_digest, 'capturedAt', CASE WHEN i.snapshot_captured_at = date_trunc('milliseconds', i.snapshot_captured_at) THEN to_char(i.snapshot_captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
'snapshot', i.transaction_snapshot_json) ORDER BY i.ordinal)
FROM (SELECT * FROM rms_ordering.order_item
 WHERE brand_id=$1 AND store_id=$2 AND order_id=h.order_id AND order_batch_id=b.order_batch_id
 ORDER BY ordinal LIMIT 101) i), '[]'::jsonb)) AS history
FROM rms_ordering.order_submission_record s
LEFT JOIN rms_ordering.order_header h ON h.order_id=s.order_id AND h.brand_id=$1 AND h.store_id=$2
LEFT JOIN rms_ordering.order_batch b ON b.order_id=h.order_id AND b.submission_id=s.submission_id
 AND b.brand_id=$1 AND b.store_id=$2
LEFT JOIN rms_ordering.order_number_allocation n ON n.order_id=h.order_id AND n.brand_id=$1 AND n.store_id=$2
WHERE s.brand_id=$1 AND s.store_id=$2 AND s.submission_id=$3 AND s.submission_kind='Initial' LIMIT 2`;

function unavailable(): never {
  throw new OrderCreationError("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return unavailable();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return unavailable();
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return unavailable();
    out[key] = d.value;
  }
  return out;
}
function capture(value: unknown): unknown {
  let nodes = 0,
    characters = 0;
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > 200000 || depth > 40) return unavailable();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      characters += v.length;
      if (characters > 64 * 1024 * 1024) return unavailable();
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) return unavailable();
      return v;
    }
    if (typeof v !== "object" || ancestors.has(v)) return unavailable();
    ancestors.add(v);
    try {
      const keys = Reflect.ownKeys(v);
      if (keys.length > 1001) return unavailable();
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 1000 ||
          keys.length !== v.length + 1
        )
          return unavailable();
        const out: unknown[] = [];
        for (let i = 0; i < v.length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d?.enumerable || !("value" in d)) return unavailable();
          out.push(visit(d.value, depth + 1));
        }
        return out;
      }
      if (Object.getPrototypeOf(v) !== Object.prototype) return unavailable();
      const entries: [string, unknown][] = [];
      for (const key of keys) {
        if (typeof key !== "string" || key.length > 256) return unavailable();
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d?.enumerable || !("value" in d)) return unavailable();
        entries.push([key, visit(d.value, depth + 1)]);
      }
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(v);
    }
  }
  return visit(value, 0);
}
function decode<V extends 1 | 2>(history: unknown, quoteVersion: V): OrderCreationRecord<V> {
  const h = exact(history, ["record", "source", "items"]);
  const r = exact(h.record, [
    "submissionReference",
    "submissionIntentHash",
    "guestSessionReference",
    "order",
    "items",
    "orderNumberAllocation",
    "createdAt",
  ]);
  const o = exact(r.order, [
    "orderReference",
    "brandReference",
    "storeReference",
    "orderType",
    "sourceChannel",
    "diningSessionReference",
    "createdByActorReference",
    "submittedByActorReference",
    "aggregateVersion",
    "canonicalPhase",
    "closureStatus",
    "paymentStatus",
    "createdAt",
    "batches",
  ]);
  if (
    !Array.isArray(o.batches) ||
    o.batches.length !== 1 ||
    !Array.isArray(h.items) ||
    h.items.length < 1 ||
    h.items.length > 100 ||
    !Array.isArray(r.items) ||
    r.items.length !== 0
  )
    return unavailable();
  const b = exact(o.batches[0], [
    "orderBatchReference",
    "orderReference",
    "submissionReference",
    "sourceCartReference",
    "sourceCartVersion",
    "checkoutValidationReference",
    "quoteReference",
    "submittedByActorReference",
    "submittedAt",
    "items",
  ]);
  if (!Array.isArray(b.items) || b.items.length !== 0) return unavailable();
  const identities: unknown[] = [];
  const snapshots = h.items.map((value, index) => {
    const row = exact(value, [
      "ordinal",
      "orderItemReference",
      "orderBatchReference",
      "cartItemReference",
      "quantity",
      "catalogDigest",
      "quoteDigest",
      "capturedAt",
      "snapshot",
    ]);
    if (row.ordinal !== index + 1) return unavailable();
    const item = (quoteVersion === 2 ? decodeConfiguredOrderItemSnapshot : decodeOrderItemSnapshot)(
      row.snapshot,
    );
    if (
      row.orderItemReference !== item.orderItemReference ||
      row.orderBatchReference !== item.orderBatchReference ||
      row.cartItemReference !== item.cartItemReference ||
      row.quantity !== item.quantity ||
      row.catalogDigest !== item.catalog.snapshotDigest ||
      row.quoteDigest !== item.pricing.quoteInputDigest ||
      row.capturedAt !== item.snapshotCapturedAt
    )
      return unavailable();
    identities.push({
      orderItemReference: row.orderItemReference,
      orderBatchReference: row.orderBatchReference,
      cartItemReference: row.cartItemReference,
    });
    return item;
  });
  const n = exact(r.orderNumberAllocation, [
    "orderReference",
    "brandReference",
    "storeReference",
    "businessDate",
    "sequence",
    "orderNumber",
    "allocatedAt",
    "businessDateResolution",
  ]);
  if (typeof n.sequence !== "string" || !/^[1-9][0-9]{0,18}$/u.test(n.sequence))
    return unavailable();
  const parsed = (
    quoteVersion === 2 ? parseConfiguredOrderCreationRecord : parseOrderCreationRecord
  )({
    ...r,
    items: snapshots,
    order: { ...o, batches: [{ ...b, items: identities }] },
    orderNumberAllocation: { ...n, sequence: BigInt(n.sequence) },
  });
  const s = exact(h.source, ["cart", "version", "quote", "businessDate", "orderNumber"]);
  const batch = parsed.order.batches[0];
  if (
    s.cart !== batch.sourceCartReference ||
    s.version !== batch.sourceCartVersion ||
    s.quote !== batch.quoteReference ||
    s.businessDate !== parsed.orderNumberAllocation.businessDate ||
    s.orderNumber !== parsed.orderNumberAllocation.orderNumber
  )
    return unavailable();
  return parsed as OrderCreationRecord<V>;
}

/** Internal immutable history, including restricted notes; caller must authorize current access. */
export function createPostgresOrderCreationQueryStore<V extends 1 | 2 = 1>(
  runner: OrderCreationQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  quoteVersion: V = 1 as V,
) {
  const fixed = exact(scope, ["brandReference", "storeReference"]);
  const brand = parseOrderingReference(fixed.brandReference),
    store = parseOrderingReference(fixed.storeReference);
  return Object.freeze({
    /** Current initial Order state; caller authorizes access and retains this transaction through commit. */
    async withCurrentSubmission<T>(
      value: string,
      work: (
        transaction: OrderCreationQueryTransaction,
        record: OrderCreationRecord<V>,
      ) => Promise<T>,
    ): Promise<T | null> {
      const reference = parseOrderingReference(value);
      try {
        return await runner.run(async (transaction) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, store],
          );
          const result = await transaction.query(
            "SELECT h.order_id AS reference FROM rms_ordering.order_header h JOIN rms_ordering.order_submission_record s ON s.order_id=h.order_id AND s.brand_id=h.brand_id AND s.store_id=h.store_id WHERE h.brand_id=$1 AND h.store_id=$2 AND s.submission_id=$3 AND s.submission_kind='Initial' FOR UPDATE OF h",
            [brand, store, reference],
          );
          if (result === null || typeof result !== "object") return unavailable();
          const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
          if (!descriptor || !("value" in descriptor)) return unavailable();
          const locked = capture(descriptor.value);
          if (!Array.isArray(locked) || locked.length > 1) return unavailable();
          if (locked.length === 0) return null;
          const orderReference = parseOrderingReference(exact(locked[0], ["reference"]).reference);
          const record = await readOrderCreationHistory(
            transaction,
            { brandReference: brand, storeReference: store },
            reference,
            quoteVersion,
          );
          if (record === null || record.order.orderReference !== orderReference)
            return unavailable();
          return work(transaction, record);
        });
      } catch {
        return unavailable();
      }
    },
    async resolveSubmission(value: string): Promise<OrderCreationRecord<V> | null> {
      const reference = parseOrderingReference(value);
      try {
        return await runner.run(async (transaction) => {
          await transaction.query("SET TRANSACTION READ ONLY", []);
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, store],
          );
          return readOrderCreationHistory(
            transaction,
            { brandReference: brand, storeReference: store },
            reference,
            quoteVersion,
          );
        });
      } catch {
        return unavailable();
      }
    },
  });
}

/** Owner-local reuse inside a writer transaction; the caller owns isolation and local scope context. */
export async function readOrderCreationHistory<V extends 1 | 2 = 1>(
  transaction: OrderCreationQueryTransaction,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  value: string,
  quoteVersion: V = 1 as V,
): Promise<OrderCreationRecord<V> | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    reference = parseOrderingReference(value);
  const result = await transaction.query(selectHistory, [brand, store, reference]);
  if (result === null || typeof result !== "object") return unavailable();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d?.enumerable || !("value" in d)) return unavailable();
  const rows = capture(d.value);
  if (!Array.isArray(rows) || rows.length > 1) return unavailable();
  if (rows.length === 0) return null;
  const row = exact(rows[0], ["history"]);
  const record = decode(row.history, quoteVersion);
  if (
    record.submissionReference !== reference ||
    record.order.brandReference !== brand ||
    record.order.storeReference !== store
  )
    return unavailable();
  return record;
}

/**
 * WP-2423: the Quote version an Order was priced with, from its immutable item snapshots (their
 * discriminator), so readers of mixed history decode each Order with its own version.
 */
export async function readOrderCreationQuoteVersion(
  transaction: OrderCreationQueryTransaction,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  value: string,
): Promise<1 | 2 | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    reference = parseOrderingReference(value);
  const result = await transaction.query(selectHistory, [brand, store, reference]);
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d?.enumerable || !("value" in d)) return unavailable();
  const rows = capture(d.value);
  if (!Array.isArray(rows) || rows.length > 1) return unavailable();
  if (rows.length === 0) return null;
  const history = exact(rows[0], ["history"]).history as {
    readonly items?: readonly {
      readonly snapshot?: { readonly pricing?: { readonly quoteVersion?: unknown } };
    }[];
  };
  const versions = new Set(
    (history.items ?? []).map((item) => item.snapshot?.pricing?.quoteVersion),
  );
  const [version] = versions;
  if (versions.size !== 1 || (version !== 1 && version !== 2)) return unavailable();
  return version;
}
