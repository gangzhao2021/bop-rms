import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
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

/** WP-2423 M03: an Order that already holds a Cart version's dishes. */
export interface CartOrderedRecord {
  readonly submissionReference: string;
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly guestSessionReference: string;
  readonly sourceCartVersion: number;
  /**
   * The Order will not be made: closed or cancelled (a termination is recorded) or its payment was
   * cancelled unpaid. The same rule as `readRestorableCartOrder`.
   */
  readonly notMade: boolean;
}
/** WP-2423 M03: the Order `s` will not be made (as `readRestorableCartOrder`); $1/$2 scope it. */
const notMadeSql = `(EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t
   WHERE t.brand_id=$1 AND t.store_id=$2 AND t.order_id=s.order_id)
 OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_failure_record f
   WHERE f.brand_id=$1 AND f.store_id=$2 AND f.order_id=s.order_id AND f.reason='Cancelled'))`;
type CartOrderedCandidate = Omit<CartOrderedRecord, "notMade">;
function cartOrderedCandidates(result: unknown, limit: number): CartOrderedCandidate[] {
  if (result === null || typeof result !== "object") return unavailable();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d?.enumerable || !("value" in d)) return unavailable();
  const rows = capture(d.value);
  if (!Array.isArray(rows) || rows.length > limit) return unavailable();
  return rows.map((value) => {
    const row = exact(value, [
      "submission_id",
      "order_id",
      "order_number",
      "guest_session_id",
      "source_cart_version",
    ]);
    if (
      typeof row.order_number !== "string" ||
      !/^[1-9][0-9]{0,18}$/u.test(row.order_number) ||
      !Number.isSafeInteger(row.source_cart_version) ||
      (row.source_cart_version as number) < 1
    )
      return unavailable();
    return {
      submissionReference: parseOrderingReference(row.submission_id),
      orderReference: parseOrderingReference(row.order_id),
      orderNumber: row.order_number,
      guestSessionReference: parseOrderingReference(row.guest_session_id),
      sourceCartVersion: row.source_cart_version as number,
    };
  });
}
/**
 * Which of these Orders will not be made. Read only once an Order was found (so an ordinary new
 * Order never reads termination or payment-failure records).
 */
async function readNotMade(
  transaction: OrderCreationQueryTransaction,
  brand: string,
  store: string,
  orders: readonly string[],
): Promise<ReadonlySet<string>> {
  const result = await transaction.query(
    `SELECT s.order_id FROM unnest($3::uuid[]) AS s(order_id) WHERE ${notMadeSql}`,
    [brand, store, orders],
  );
  if (result === null || typeof result !== "object") return unavailable();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d?.enumerable || !("value" in d)) return unavailable();
  const rows = capture(d.value);
  if (!Array.isArray(rows) || rows.length > orders.length) return unavailable();
  return new Set(rows.map((row) => parseOrderingReference(exact(row, ["order_id"]).order_id)));
}
const record = (candidate: CartOrderedCandidate, notMade: boolean): CartOrderedRecord =>
  Object.freeze({ ...candidate, notMade });
/** At most this many Orders hold one legacy Cart's lines; more is not a real Cart. */
const candidateLimit = 20;
/**
 * WP-2423 M03: the Order already made from this exact Cart version, or from a line the Cart still
 * holds (a Cart filled before pickup Carts were emptied on ordering) unless that Order will not be
 * made (its dishes may then be ordered again from a changed Cart). Read on the caller's
 * transaction with local Brand/Store context set; the caller authorizes and decides.
 */
export async function readCartVersionOrder(
  transaction: OrderCreationQueryTransaction,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  value: Readonly<{ cartReference: string; cartVersion: number }>,
): Promise<CartOrderedRecord | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    cart = parseOrderingReference(value.cartReference);
  if (!Number.isSafeInteger(value.cartVersion) || value.cartVersion < 1) return unavailable();
  const candidates = cartOrderedCandidates(
    await transaction.query(
      `SELECT s.submission_id,s.order_id,h.order_number,s.guest_session_id,s.source_cart_version
       FROM rms_ordering.order_submission_record s
       JOIN rms_ordering.order_header h ON h.order_id=s.order_id AND h.brand_id=$1 AND h.store_id=$2
       WHERE s.brand_id=$1 AND s.store_id=$2 AND s.source_cart_id=$3
         AND (s.source_cart_version=$4 OR EXISTS (
           SELECT 1 FROM rms_ordering.order_item i
           JOIN rms_ordering.cart_line l ON l.cart_line_id=i.source_cart_line_id AND l.brand_id=$1
             AND l.store_id=$2 AND l.cart_id=$3
           WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=s.order_id))
       ORDER BY (s.source_cart_version=$4) DESC, s.created_at DESC, s.submission_id DESC
       LIMIT ${candidateLimit}`,
      [brand, store, cart, value.cartVersion],
    ),
    candidateLimit,
  );
  if (candidates.length === 0) return null;
  const notMade = await readNotMade(
    transaction,
    brand,
    store,
    candidates.map((candidate) => candidate.orderReference),
  );
  // The exact version is always ordered; a line held only by an Order that won't be made is free.
  const found = candidates.find(
    (candidate) =>
      candidate.sourceCartVersion === value.cartVersion || !notMade.has(candidate.orderReference),
  );
  return found === undefined ? null : record(found, notMade.has(found.orderReference));
}
/**
 * WP-2423 M03: the guest's latest Order from this Cart while nothing was put in the Cart after it
 * (no Cart item operation at a later version), so an emptied Cart can say "already ordered" (or,
 * when it won't be made, offer its dishes back).
 */
export async function readLatestCartOrder(
  transaction: OrderCreationQueryTransaction,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  value: Readonly<{ cartReference: string; guestSessionReference: string }>,
): Promise<CartOrderedRecord | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    cart = parseOrderingReference(value.cartReference),
    guest = parseOrderingReference(value.guestSessionReference);
  const [found] = cartOrderedCandidates(
    await transaction.query(
      `SELECT s.submission_id,s.order_id,h.order_number,s.guest_session_id,s.source_cart_version
       FROM (SELECT * FROM rms_ordering.order_submission_record
             WHERE brand_id=$1 AND store_id=$2 AND source_cart_id=$3
             ORDER BY source_cart_version DESC, created_at DESC LIMIT 1) s
       JOIN rms_ordering.order_header h ON h.order_id=s.order_id AND h.brand_id=$1 AND h.store_id=$2
       WHERE s.guest_session_id=$4 AND NOT EXISTS (
         SELECT 1 FROM rms_ordering.cart_operation_record o
         WHERE o.brand_id=$1 AND o.store_id=$2 AND o.cart_id=$3
           AND o.result_aggregate_version>s.source_cart_version)`,
      [brand, store, cart, guest],
    ),
    1,
  );
  if (found === undefined) return null;
  const notMade = await readNotMade(transaction, brand, store, [found.orderReference]);
  return record(found, notMade.has(found.orderReference));
}
/**
 * WP-2423 (same-table-ordering): a table round sent from this Cart in the last 15 minutes — its
 * number at the table (rounds of the table's Order by time), when, which Guest Session paid it and
 * which Cart lines it took — so every phone can say "these dishes were sent by someone at your
 * table", whatever was added to the Cart since. At most 5, newest first. Read on the caller's
 * transaction with local Brand/Store context set.
 *
 * WP-2423 M38: with where its payment stands, from Ordering's own records — StaffDeclined (staff
 * cancelled it before it was sent: STAFF_CANCELLED_UNPAID, which is also how a round held for staff
 * is declined), Cancelled (closed by the payment window — deadline, payment not started or not
 * completed — or paid with nothing it could still make: nobody on staff touched it),
 * StaffCancelled (staff cancelled it after it was sent: the whole round, or every one of its
 * dishes taken off), PayLater (sent to the
 * kitchen to be paid at the end), Paid, WaitingForStaff (a guest round held for staff that no one
 * has sent or cancelled yet: nobody is paying for it), else AwaitingPayment (neither paid nor sent:
 * at a pay-first table its checkout is open; at a pay-later table its send is not confirmed yet —
 * the caller, which knows the table's payment timing, words it). A round still open
 * (AwaitingPayment or WaitingForStaff) is included whatever its age, but the list is always the
 * newest first, so an old stuck round never hides the newer ones (and drops out after 5 newer).
 */
export type RecentCartRoundPaymentState =
  | "AwaitingPayment"
  | "WaitingForStaff"
  | "Paid"
  | "PayLater"
  | "Cancelled"
  | "StaffDeclined"
  | "StaffCancelled";
const recentCartRoundPaymentStates: readonly RecentCartRoundPaymentState[] = Object.freeze([
  "AwaitingPayment",
  "WaitingForStaff",
  "Paid",
  "PayLater",
  "Cancelled",
  "StaffDeclined",
  "StaffCancelled",
]);
export interface RecentCartRound {
  readonly roundNumber: number;
  readonly sentAt: string;
  readonly guestSessionReference: string;
  /**
   * The table participant whose Guest Session paid it, from Ordering's own record of that session
   * opening this table's Cart; null when there is none (then only the session can be compared).
   */
  readonly participantReference: string | null;
  readonly cartItemReferences: readonly string[];
  readonly paymentState: RecentCartRoundPaymentState;
}
export async function readRecentCartRounds(
  transaction: OrderCreationQueryTransaction,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  value: Readonly<{ cartReference: string; observedAt: string }>,
): Promise<readonly RecentCartRound[]> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    cart = parseOrderingReference(value.cartReference),
    observedAt = parseOrderingInstant(value.observedAt);
  const result = await transaction.query(
    `SELECT r.round_number::integer AS "roundNumber",
       to_char(r.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sentAt",
       r.guest_session_id::text AS "guestSessionReference",
       (SELECT o.participant_id::text FROM rms_ordering.dining_cart_operation o
         JOIN rms_ordering.cart c ON c.cart_id=$3 AND c.brand_id=$1 AND c.store_id=$2
         WHERE o.brand_id=$1 AND o.store_id=$2 AND o.dining_session_id=c.dining_session_id
           AND o.guest_session_id=r.guest_session_id
         ORDER BY o.occurred_at, o.operation_id LIMIT 1) AS "participantReference",
       COALESCE((SELECT array_agg(i.source_cart_line_id::text ORDER BY i.source_cart_line_id)
           FILTER (WHERE i.source_cart_line_id IS NOT NULL)
         FROM rms_ordering.order_item i WHERE i.brand_id=$1 AND i.store_id=$2
           AND i.order_batch_id=r.order_batch_id), '{}') AS "cartItemReferences",
       r.payment_state AS "paymentState"
     FROM (SELECT q.*, CASE
             WHEN EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation x
               WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_batch_id=q.order_batch_id
                 AND x.reason_code='STAFF_CANCELLED_UNPAID') THEN 'StaffDeclined'
             WHEN EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation x
               WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_batch_id=q.order_batch_id)
               THEN 'Cancelled'
             WHEN EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation x
               WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_batch_id=q.order_batch_id)
               OR NOT EXISTS (SELECT 1 FROM rms_ordering.order_item i
                 WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_batch_id=q.order_batch_id
                   AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_item_staff_cancellation x
                     WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_batch_id=q.order_batch_id
                       AND i.order_item_id = ANY (x.order_item_ids)))
               THEN 'StaffCancelled'
             WHEN EXISTS (SELECT 1 FROM rms_ordering.order_pay_later_confirmation x
               WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_batch_id=q.order_batch_id)
               THEN 'PayLater'
             WHEN EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record x
               WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_batch_id=q.order_batch_id
                 AND x.disposition='PaidWithoutFulfillableOrder') THEN 'Cancelled'
             WHEN EXISTS (SELECT 1 FROM rms_ordering.order_payment_acceptance_wait x
               WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_batch_id=q.order_batch_id)
               OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record x
               WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_batch_id=q.order_batch_id)
               THEN 'Paid'
             WHEN EXISTS (SELECT 1 FROM rms_ordering.order_round_staff_hold x
               WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_batch_id=q.order_batch_id)
               THEN 'WaitingForStaff'
             ELSE 'AwaitingPayment' END AS payment_state
           FROM (SELECT b.order_batch_id,b.submitted_at,b.source_cart_id,s.guest_session_id,
                   row_number() OVER (PARTITION BY b.order_id ORDER BY b.submitted_at,b.order_batch_id)
                     AS round_number
                 FROM rms_ordering.order_batch b
                 JOIN rms_ordering.order_submission_record s ON s.submission_id=b.submission_id
                   AND s.brand_id=$1 AND s.store_id=$2
                 WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id IN (
                   SELECT o.order_id FROM rms_ordering.order_batch o
                   WHERE o.brand_id=$1 AND o.store_id=$2 AND o.source_cart_id=$3)) q
           WHERE q.source_cart_id=$3 AND q.submitted_at <= $4::timestamptz) r
     WHERE r.submitted_at > $4::timestamptz - interval '15 minutes'
       OR r.payment_state IN ('AwaitingPayment','WaitingForStaff')
     ORDER BY r.submitted_at DESC, r.order_batch_id DESC
     LIMIT 5`,
    [brand, store, cart, observedAt],
  );
  const rows =
    result !== null && typeof result === "object" && "rows" in result ? result.rows : null;
  if (!Array.isArray(rows) || rows.length > 5) return unavailable();
  return Object.freeze(
    rows.map((row: unknown) => {
      const raw = exact(row, [
        "roundNumber",
        "sentAt",
        "guestSessionReference",
        "participantReference",
        "cartItemReferences",
        "paymentState",
      ]);
      if (
        !recentCartRoundPaymentStates.includes(raw.paymentState as RecentCartRoundPaymentState) ||
        typeof raw.roundNumber !== "number" ||
        !Number.isSafeInteger(raw.roundNumber) ||
        raw.roundNumber < 1 ||
        !Array.isArray(raw.cartItemReferences) ||
        raw.cartItemReferences.length > 100
      )
        return unavailable();
      return Object.freeze({
        roundNumber: raw.roundNumber,
        sentAt: parseOrderingInstant(raw.sentAt),
        guestSessionReference: parseOrderingReference(raw.guestSessionReference),
        participantReference:
          raw.participantReference === null
            ? null
            : parseOrderingReference(raw.participantReference),
        cartItemReferences: Object.freeze(
          raw.cartItemReferences.map((reference: unknown) => parseOrderingReference(reference)),
        ),
        paymentState: raw.paymentState as RecentCartRoundPaymentState,
      });
    }),
  );
}
/** WP-2423 M03: one ordered dish as the guest chose it, to put back in the Cart. */
export interface RestorableOrderLine {
  readonly orderItemReference: string;
  readonly sellableReference: string;
  readonly quantity: number;
  readonly optionSelections: readonly {
    readonly optionReference: string;
    readonly quantity: number;
  }[];
  readonly customerNote: string | null;
}
/**
 * WP-2423 M03: a pickup Order made from this Cart that will not be made — closed or cancelled
 * (a termination is recorded) or whose payment was cancelled unpaid — with its dishes as ordered,
 * so the guest can put them back in the Cart instead of choosing everything again. Null for any
 * other Order. Read on the caller's transaction with local Brand/Store context set.
 */
export async function readRestorableCartOrder(
  transaction: OrderCreationQueryTransaction,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  value: Readonly<{ cartReference: string; orderReference: string }>,
): Promise<{
  readonly orderNumber: string;
  readonly lines: readonly RestorableOrderLine[];
} | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    cart = parseOrderingReference(value.cartReference),
    order = parseOrderingReference(value.orderReference);
  const result = await transaction.query(
    `SELECT s.submission_id FROM rms_ordering.order_submission_record s
     JOIN rms_ordering.order_header h ON h.order_id=s.order_id AND h.brand_id=$1 AND h.store_id=$2
     WHERE s.brand_id=$1 AND s.store_id=$2 AND s.order_id=$3 AND s.source_cart_id=$4
       AND s.submission_kind='Initial' AND h.order_type='Pickup' AND ${notMadeSql}`,
    [brand, store, order, cart],
  );
  if (result === null || typeof result !== "object") return unavailable();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d?.enumerable || !("value" in d)) return unavailable();
  const rows = capture(d.value);
  if (!Array.isArray(rows) || rows.length > 1) return unavailable();
  if (rows.length === 0) return null;
  const submission = parseOrderingReference(exact(rows[0], ["submission_id"]).submission_id);
  const quoteVersion = await readOrderCreationQuoteVersion(transaction, scope, submission);
  if (quoteVersion === null) return unavailable();
  const record = await readOrderCreationHistory(transaction, scope, submission, quoteVersion);
  if (
    record === null ||
    record.order.orderReference !== order ||
    record.order.orderType !== "Pickup" ||
    record.order.batches[0]?.sourceCartReference !== cart
  )
    return unavailable();
  return Object.freeze({
    orderNumber: record.orderNumberAllocation.orderNumber,
    lines: Object.freeze(
      record.items.map((item) =>
        Object.freeze({
          orderItemReference: String(item.orderItemReference),
          sellableReference: String(item.catalog.sellableReference),
          quantity: item.quantity,
          optionSelections: Object.freeze(
            item.catalog.options.map((option) =>
              Object.freeze({
                optionReference: String(option.optionReference),
                quantity: option.quantity,
              }),
            ),
          ),
          customerNote: item.customerNote,
        }),
      ),
    ),
  });
}
/** Dedicated read-only lookup of `readCartVersionOrder`; the caller authorizes the guest first. */
export function createPostgresCartOrderLookup(
  runner: OrderCreationQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const fixed = exact(scope, ["brandReference", "storeReference"]);
  const local = Object.freeze({
    brandReference: parseOrderingReference(fixed.brandReference),
    storeReference: parseOrderingReference(fixed.storeReference),
  });
  async function run<T>(work: (transaction: OrderCreationQueryTransaction) => Promise<T>) {
    try {
      return await runner.run(async (transaction) => {
        await transaction.query("SET TRANSACTION READ ONLY", []);
        await transaction.query(
          "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
          [local.brandReference, local.storeReference],
        );
        return work(transaction);
      });
    } catch {
      return unavailable();
    }
  }
  return Object.freeze({
    findVersion: (value: Readonly<{ cartReference: string; cartVersion: number }>) =>
      run((transaction) => readCartVersionOrder(transaction, local, value)),
    findLatest: (value: Readonly<{ cartReference: string; guestSessionReference: string }>) =>
      run((transaction) => readLatestCartOrder(transaction, local, value)),
    findRestorable: (value: Readonly<{ cartReference: string; orderReference: string }>) =>
      run((transaction) => readRestorableCartOrder(transaction, local, value)),
    recentRounds: (value: Readonly<{ cartReference: string; observedAt: string }>) =>
      run((transaction) => readRecentCartRounds(transaction, local, value)),
  });
}
