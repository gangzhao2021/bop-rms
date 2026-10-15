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
 * WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): a dine-in round staff entered for a table (or a
 * paper round entered after an outage). The round is the Order batch submitted by the table guest
 * session the staff command opened for it; this record names the staff member, the table and
 * dining session, and makes the staff command idempotent.
 */
export interface StaffDiningRoundEntryRecord {
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly operationReference: OrderingReference;
  readonly intentHash: OrderingHash;
  readonly actorReference: OrderingReference;
  readonly tableReference: OrderingReference;
  readonly diningSessionReference: OrderingReference;
  readonly guestSessionReference: OrderingReference;
  /** The Payment tip choice staff record for this round (chosen up front). */
  readonly tipSelectionReference: OrderingReference;
  readonly recordedAfterOutage: boolean;
  readonly createdAt: OrderingInstant;
  readonly auditReference: OrderingReference;
}

export class StaffDiningRoundEntryError extends Error {
  readonly code: "STAFF_DINING_ROUND_IDEMPOTENCY_CONFLICT" | "STAFF_DINING_ROUND_UNAVAILABLE";
  constructor(code: StaffDiningRoundEntryError["code"]) {
    super("staff dining round entry is unavailable");
    this.name = "StaffDiningRoundEntryError";
    this.code = code;
  }
}
const fail = (
  code: StaffDiningRoundEntryError["code"] = "STAFF_DINING_ROUND_UNAVAILABLE",
): never => {
  throw new StaffDiningRoundEntryError(code);
};

function rows(result: unknown): readonly Record<string, unknown>[] {
  const value = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(value)) return fail();
  return value as Record<string, unknown>[];
}

const keys = [
  "brandReference",
  "storeReference",
  "operationReference",
  "intentHash",
  "actorReference",
  "tableReference",
  "diningSessionReference",
  "guestSessionReference",
  "tipSelectionReference",
  "recordedAfterOutage",
  "createdAt",
  "auditReference",
] as const;

export function parseStaffDiningRoundEntryRecord(value: unknown): StaffDiningRoundEntryRecord {
  try {
    const raw = value as Record<string, unknown>;
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
      tableReference: parseOrderingReference(raw.tableReference),
      diningSessionReference: parseOrderingReference(raw.diningSessionReference),
      guestSessionReference: parseOrderingReference(raw.guestSessionReference),
      tipSelectionReference: parseOrderingReference(raw.tipSelectionReference),
      recordedAfterOutage: raw.recordedAfterOutage,
      createdAt: parseOrderingInstant(raw.createdAt),
      auditReference: parseOrderingReference(raw.auditReference),
    });
  } catch (error) {
    if (error instanceof StaffDiningRoundEntryError) throw error;
    return fail();
  }
}

const select = `SELECT jsonb_build_object('brandReference',e.brand_id,'storeReference',e.store_id,
 'operationReference',e.operation_id,'intentHash',e.intent_hash,'actorReference',e.actor_id,
 'tableReference',e.table_id,'diningSessionReference',e.dining_session_id,
 'guestSessionReference',e.guest_session_id,'tipSelectionReference',e.tip_selection_id,
 'recordedAfterOutage',e.recorded_after_outage,
 'createdAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'auditReference',e.audit_id) AS record FROM rms_ordering.staff_dining_round_entry e`;

/** The round (Order batch) a staff entry's table guest session submitted. */
export interface StaffDiningRoundBatch {
  readonly orderReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly submissionReference: OrderingReference;
  /** The table Order's number and current version (acceptance names the version it saw). */
  readonly orderNumber: string;
  readonly orderVersion: number;
}

/** Owner persistence; the caller holds the transaction and authorizes the staff member. */
export function createPostgresStaffDiningRoundEntryStore(options: {
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
    return parseStaffDiningRoundEntryRecord(found[0]?.record);
  };
  const batchOf = (row: Record<string, unknown>): StaffDiningRoundBatch =>
    Object.freeze({
      orderReference: parseOrderingReference(row.orderReference),
      orderBatchReference: parseOrderingReference(row.orderBatchReference),
      submissionReference: parseOrderingReference(row.submissionReference),
      orderNumber:
        typeof row.orderNumber === "string" && /^[1-9][0-9]{0,18}$/u.test(row.orderNumber)
          ? row.orderNumber
          : fail(),
      orderVersion:
        Number.isSafeInteger(Number(row.orderVersion)) && Number(row.orderVersion) > 0
          ? Number(row.orderVersion)
          : fail(),
    });
  return Object.freeze({
    loadByOperation,
    /** Records the staff command once its table guest session exists; a retry replays it. */
    async record(tx: AuditTransaction, value: StaffDiningRoundEntryRecord) {
      const entry = parseStaffDiningRoundEntryRecord(value);
      if (entry.brandReference !== brand || entry.storeReference !== store) return fail();
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "StaffDiningRoundEntry:" + brand + ":" + store + ":" + entry.operationReference,
      ]);
      const prior = await loadByOperation(tx, entry.operationReference);
      if (prior !== null) {
        if (prior.intentHash !== entry.intentHash || prior.actorReference !== entry.actorReference)
          return fail("STAFF_DINING_ROUND_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, record: prior });
      }
      await tx.query(
        `INSERT INTO rms_ordering.staff_dining_round_entry (brand_id,store_id,operation_id,intent_hash,
 actor_id,table_id,dining_session_id,guest_session_id,tip_selection_id,recorded_after_outage,created_at,
 audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          brand,
          store,
          entry.operationReference,
          entry.intentHash,
          entry.actorReference,
          entry.tableReference,
          entry.diningSessionReference,
          entry.guestSessionReference,
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
        actionCode: "ORDERING_STAFF_DINING_ROUND_STARTED",
        targetType: "DiningSession",
        targetId: entry.diningSessionReference,
        afterSummary: { recordedAfterOutage: entry.recordedAfterOutage },
        reasonCode: entry.recordedAfterOutage ? "RECORDED_AFTER_OUTAGE" : "STAFF_DINING_ROUND",
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
    /** The round the entry's table guest session submitted, if it was submitted. */
    async loadBatch(
      tx: AuditTransaction,
      guestSessionReference: string,
    ): Promise<StaffDiningRoundBatch | null> {
      await context(tx);
      const found = rows(
        await tx.query(
          `SELECT b.order_id AS "orderReference",b.order_batch_id AS "orderBatchReference",
 b.submission_id AS "submissionReference",h.order_number AS "orderNumber",
 h.aggregate_version AS "orderVersion" FROM rms_ordering.order_batch b
 JOIN rms_ordering.order_header h ON h.brand_id=b.brand_id AND h.store_id=b.store_id AND h.order_id=b.order_id
 WHERE b.brand_id=$1 AND b.store_id=$2 AND b.submitted_by_actor_id=$3 AND h.order_type='DineIn'`,
          [brand, store, parseOrderingReference(guestSessionReference)],
        ),
      );
      if (found.length > 1) return fail();
      const row = found[0];
      return row === undefined ? null : batchOf(row);
    },
    /** Staff entries behind rounds of these Orders, keyed by Order batch. */
    async listByOrders(tx: AuditTransaction, orderReferences: readonly string[]) {
      await context(tx);
      const result = new Map<
        string,
        { readonly orderReference: string; readonly entry: StaffDiningRoundEntryRecord }
      >();
      if (orderReferences.length === 0) return result;
      if (orderReferences.length > 1000) return fail();
      const found = rows(
        await tx.query(
          `SELECT b.order_id::text AS order_reference,b.order_batch_id::text AS order_batch_reference,
 ${select.slice("SELECT ".length)}
 JOIN rms_ordering.order_batch b ON b.brand_id=e.brand_id AND b.store_id=e.store_id
 AND b.submitted_by_actor_id=e.guest_session_id
 WHERE e.brand_id=$1 AND e.store_id=$2 AND b.order_id = ANY($3::uuid[])`,
          [brand, store, orderReferences.map((value) => parseOrderingReference(value))],
        ),
      );
      for (const row of found) {
        const batch = String(parseOrderingReference(row.order_batch_reference));
        if (result.has(batch)) return fail();
        result.set(
          batch,
          Object.freeze({
            orderReference: String(parseOrderingReference(row.order_reference)),
            entry: parseStaffDiningRoundEntryRecord(row.record),
          }),
        );
      }
      return result;
    },
  });
}
