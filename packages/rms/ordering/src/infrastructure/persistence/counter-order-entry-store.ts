import { appendAuditRecordInTransaction, type AuditTransaction } from "@bop/audit";

import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "../../domain/cart.js";

/**
 * WP-2423 Q7: a pickup order staff took at the counter for a walk-up guest (or entered after an
 * outage from a paper order). The counter Cart belongs to the guest session the counter opened;
 * this record names the staff member and makes the staff command idempotent.
 */
export interface CounterOrderEntryRecord {
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly operationReference: OrderingReference;
  readonly intentHash: OrderingHash;
  readonly actorReference: OrderingReference;
  readonly guestSessionReference: OrderingReference;
  readonly cartReference: OrderingReference;
  /** The Payment tip choice the counter records for this order (chosen up front). */
  readonly tipSelectionReference: OrderingReference;
  readonly recordedAfterOutage: boolean;
  readonly createdAt: OrderingInstant;
  readonly auditReference: OrderingReference;
}

export class CounterOrderEntryError extends Error {
  readonly code: "COUNTER_ORDER_IDEMPOTENCY_CONFLICT" | "COUNTER_ORDER_UNAVAILABLE";
  constructor(code: CounterOrderEntryError["code"]) {
    super("counter order entry is unavailable");
    this.name = "CounterOrderEntryError";
    this.code = code;
  }
}
const fail = (code: CounterOrderEntryError["code"] = "COUNTER_ORDER_UNAVAILABLE"): never => {
  throw new CounterOrderEntryError(code);
};

function rows(result: unknown): readonly Record<string, unknown>[] {
  const value = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(value)) return fail();
  return value as Record<string, unknown>[];
}

export function parseCounterOrderEntryRecord(value: unknown): CounterOrderEntryRecord {
  try {
    const raw = value as Record<string, unknown>;
    const keys = [
      "brandReference",
      "storeReference",
      "operationReference",
      "intentHash",
      "actorReference",
      "guestSessionReference",
      "cartReference",
      "tipSelectionReference",
      "recordedAfterOutage",
      "createdAt",
      "auditReference",
    ];
    if (
      raw === null ||
      typeof raw !== "object" ||
      Object.keys(raw).length !== keys.length ||
      keys.some((key) => !Object.prototype.hasOwnProperty.call(raw, key)) ||
      typeof raw.recordedAfterOutage !== "boolean"
    )
      return fail();
    return Object.freeze({
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      operationReference: parseOrderingReference(raw.operationReference),
      intentHash: parseOrderingHash(raw.intentHash),
      actorReference: parseOrderingReference(raw.actorReference),
      guestSessionReference: parseOrderingReference(raw.guestSessionReference),
      cartReference: parseOrderingReference(raw.cartReference),
      tipSelectionReference: parseOrderingReference(raw.tipSelectionReference),
      recordedAfterOutage: raw.recordedAfterOutage,
      createdAt: parseOrderingInstant(raw.createdAt),
      auditReference: parseOrderingReference(raw.auditReference),
    });
  } catch (error) {
    if (error instanceof CounterOrderEntryError) throw error;
    return fail();
  }
}

const select = `SELECT jsonb_build_object('brandReference',e.brand_id,'storeReference',e.store_id,
 'operationReference',e.operation_id,'intentHash',e.intent_hash,'actorReference',e.actor_id,
 'guestSessionReference',e.guest_session_id,'cartReference',e.cart_id,
 'tipSelectionReference',e.tip_selection_id,
 'recordedAfterOutage',e.recorded_after_outage,
 'createdAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'auditReference',e.audit_id) AS record FROM rms_ordering.counter_order_entry e`;

/** Owner persistence; the caller holds the transaction and authorizes the staff member. */
export function createPostgresCounterOrderEntryStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: AuditTransaction): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const context = async (tx: AuditTransaction) => {
    if ((await options.authorize(tx)) !== true) return fail();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  };
  const loadByOperation = async (tx: AuditTransaction, operationReference: string) => {
    await context(tx);
    const found = rows(
      await tx.query(`${select} WHERE e.brand_id=$1 AND e.store_id=$2 AND e.operation_id=$3`, [
        brand,
        store,
        parseOrderingReference(operationReference),
      ]),
    );
    if (found.length === 0) return null;
    return parseCounterOrderEntryRecord(found[0]?.record);
  };
  return Object.freeze({
    loadByOperation,
    /** Records the staff command once its counter Cart exists; a retry replays the record. */
    async record(tx: AuditTransaction, value: CounterOrderEntryRecord) {
      const entry = parseCounterOrderEntryRecord(value);
      if (entry.brandReference !== brand || entry.storeReference !== store) return fail();
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CounterOrderEntry:" + brand + ":" + store + ":" + entry.operationReference,
      ]);
      const prior = await loadByOperation(tx, entry.operationReference);
      if (prior !== null) {
        if (prior.intentHash !== entry.intentHash || prior.actorReference !== entry.actorReference)
          return fail("COUNTER_ORDER_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, record: prior });
      }
      await tx.query(
        `INSERT INTO rms_ordering.counter_order_entry (brand_id,store_id,operation_id,intent_hash,actor_id,
 guest_session_id,cart_id,tip_selection_id,order_type,source_channel,recorded_after_outage,created_at,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Pickup','Pos',$9,$10,$11)`,
        [
          brand,
          store,
          entry.operationReference,
          entry.intentHash,
          entry.actorReference,
          entry.guestSessionReference,
          entry.cartReference,
          entry.tipSelectionReference,
          entry.recordedAfterOutage,
          entry.createdAt,
          entry.auditReference,
        ],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: entry.auditReference,
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: entry.actorReference },
        actionCode: "ORDERING_COUNTER_ORDER_STARTED",
        targetType: "OrderingCart",
        targetId: entry.cartReference,
        afterSummary: { recordedAfterOutage: entry.recordedAfterOutage },
        reasonCode: entry.recordedAfterOutage ? "RECORDED_AFTER_OUTAGE" : "COUNTER_ORDER",
        correlationId: entry.operationReference,
        occurredAt: entry.createdAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const saved = await loadByOperation(tx, entry.operationReference);
      if (saved === null || saved.intentHash !== entry.intentHash) return fail();
      return Object.freeze({ status: "Created" as const, record: saved });
    },
    /** The Order created from a counter Cart, if it was submitted. */
    async loadOrder(tx: AuditTransaction, cartReference: string) {
      await context(tx);
      const found = rows(
        await tx.query(
          `SELECT b.order_id AS "orderReference",b.order_batch_id AS "orderBatchReference",
 b.submission_id AS "submissionReference",b.quote_id AS "quoteReference",
 b.source_cart_version AS "cartVersion" FROM rms_ordering.order_batch b
 WHERE b.brand_id=$1 AND b.store_id=$2 AND b.source_cart_id=$3`,
          [brand, store, parseOrderingReference(cartReference)],
        ),
      );
      if (found.length > 1) return fail();
      const row = found[0];
      if (row === undefined) return null;
      return Object.freeze({
        orderReference: parseOrderingReference(row.orderReference),
        orderBatchReference: parseOrderingReference(row.orderBatchReference),
        submissionReference: parseOrderingReference(row.submissionReference),
        quoteReference: parseOrderingReference(row.quoteReference),
        cartVersion: Number(row.cartVersion),
      });
    },
    /** Counter entries of these Orders (for the order queue), keyed by Order. */
    async listByOrders(tx: AuditTransaction, orderReferences: readonly string[]) {
      await context(tx);
      if (orderReferences.length === 0) return new Map<string, CounterOrderEntryRecord>();
      const found = rows(
        await tx.query(
          `SELECT DISTINCT b.order_id AS order_reference,${select.slice("SELECT ".length)}
 JOIN rms_ordering.order_batch b ON b.brand_id=e.brand_id AND b.store_id=e.store_id
 AND b.source_cart_id=e.cart_id
 WHERE e.brand_id=$1 AND e.store_id=$2 AND b.order_id = ANY($3::uuid[])`,
          [brand, store, orderReferences.map((value) => parseOrderingReference(value))],
        ),
      );
      const result = new Map<string, CounterOrderEntryRecord>();
      for (const row of found)
        result.set(
          String(parseOrderingReference(row.order_reference)),
          parseCounterOrderEntryRecord(row.record),
        );
      return result;
    },
  });
}
