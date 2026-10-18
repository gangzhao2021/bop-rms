import type { ConsumerTransaction } from "@bop/eventing";
import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AuditTransaction,
} from "@bop/audit";
import {
  parseFulfillmentReference,
  parseFulfillmentInstant,
} from "../../domain/pickup-fulfillment.js";
import {
  parseAsapCapacityCommitment,
  AsapCapacityError,
  type AsapCapacityCommitment,
} from "../../domain/asap-capacity.js";

export interface AsapCapacityTransactionRunner {
  /** Dedicated transaction; rollback on failure and clear scoped context before connection reuse. */
  run<T>(action: (transaction: AuditTransaction) => Promise<T>): Promise<T>;
}
function fail(code: AsapCapacityError["code"] = "ASAP_CAPACITY_UNAVAILABLE"): never {
  throw new AsapCapacityError(code);
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail();
    result[field] = descriptor.value;
  }
  return result;
}
function row(value: unknown): unknown | null {
  if (value === null || typeof value !== "object") fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor?.enumerable || !("value" in descriptor)) fail();
  const rows: unknown = descriptor.value;
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) fail();
  const length = Object.getOwnPropertyDescriptor(rows, "length")?.value;
  if ((length !== 0 && length !== 1) || Reflect.ownKeys(rows).length !== length + 1) fail();
  if (length === 0) return null;
  const first = Object.getOwnPropertyDescriptor(rows, "0");
  if (!first?.enumerable || !("value" in first) || first.value === null) fail();
  return first.value;
}

const selectRecord = `SELECT jsonb_build_object('slot',jsonb_build_object('brandReference',s.brand_id,'storeReference',s.store_id,'slotReference',s.slot_id,'fulfillmentType',s.fulfillment_type,'configVersion',a.config_version,'startsAt',to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'endsAt',to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
'allocationReference',a.allocation_id,
'guestSessionReference',a.guest_session_id,
'cartReference',a.cart_id,
'quoteReference',a.quote_id,
'submissionReference',a.submission_id,
'orderReference',a.order_id,
'orderBatchReference',a.order_batch_id,
'fulfillmentReference',a.fulfillment_id,
'paymentOperationReference',a.payment_operation_id,
'cartVersion',a.cart_version,
'units',a.capacity_units,
'unitsRuleVersion',a.units_rule_version,
'unitsInputDigest',a.units_input_digest,
'intentDigest',a.intent_digest,
'state',a.state,
'version',a.version,
'preparedAt',to_char(a.prepared_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'preparationValidUntil',to_char(a.preparation_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'orderingLinkedAt',to_char(a.ordering_linked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'paymentRequestedAt',to_char(a.payment_requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'capacityExpiresAt',to_char(a.capacity_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'terminalAt',to_char(a.terminal_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS record
FROM rms_fulfillment.capacity_asap_commitment a
JOIN rms_fulfillment.capacity_slot s ON s.brand_id=a.brand_id AND s.store_id=a.store_id AND s.slot_id=a.slot_id
WHERE a.brand_id=$1 AND a.store_id=$2`;
const insertRecord = `INSERT INTO rms_fulfillment.capacity_asap_commitment (brand_id,store_id,slot_id,config_version,allocation_id,guest_session_id,cart_id,quote_id,submission_id,order_id,order_batch_id,fulfillment_id,payment_operation_id,cart_version,capacity_units,units_rule_version,units_input_digest,intent_digest,state,version,prepared_at,preparation_valid_until,ordering_linked_at,payment_requested_at,capacity_expires_at,terminal_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING allocation_id AS reference`;

/** Internal owner storage. History recovery is not current checkout or Payment authorization. */
export function createPostgresAsapCapacityStore(
  runner: AsapCapacityTransactionRunner,
  scopeInput: unknown,
  clock: { now(): string },
) {
  const scope = closed(scopeInput, ["brandReference", "storeReference"]);
  const brand = parseFulfillmentReference(scope.brandReference);
  const store = parseFulfillmentReference(scope.storeReference);
  const scoped = (record: AsapCapacityCommitment) => {
    if (record.slot.brandReference !== brand || record.slot.storeReference !== store)
      return fail("ASAP_CAPACITY_INVALID");
    return record;
  };
  const context = (tx: AuditTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  async function read(
    tx: AuditTransaction,
    field: "allocation_id" | "submission_id",
    reference: string,
    version: number | null = null,
  ) {
    const found = row(
      await tx.query(
        selectRecord +
          " AND a." +
          field +
          "=$3" +
          (version === null ? " ORDER BY a.version DESC LIMIT 1" : " AND a.version=$4"),
        version === null ? [brand, store, reference] : [brand, store, reference, version],
      ),
    );
    if (found === null) return null;
    const record = scoped(parseAsapCapacityCommitment(closed(found, ["record"]).record));
    if (
      (field === "allocation_id" ? record.allocationReference : record.submissionReference) !==
        reference ||
      (version !== null && record.version !== version)
    )
      return fail();
    return record;
  }
  const safe = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AsapCapacityError) throw error;
      return fail();
    }
  };
  return Object.freeze({
    load(referenceValue: unknown) {
      return safe(async () => {
        const reference = parseFulfillmentReference(referenceValue);
        return runner.run(async (tx) => {
          await context(tx);
          return read(tx, "allocation_id", reference);
        });
      });
    },
    loadSubmission(referenceValue: unknown) {
      return safe(async () => {
        const reference = parseFulfillmentReference(referenceValue);
        return runner.run(async (tx) => {
          await context(tx);
          return read(tx, "submission_id", reference);
        });
      });
    },
    /** Latest commitment fenced against append through callback and runner completion. */
    withCurrentSubmission<T>(
      referenceValue: unknown,
      work: (transaction: AuditTransaction, record: AsapCapacityCommitment) => Promise<T>,
    ): Promise<T | null> {
      return safe(async () => {
        const reference = parseFulfillmentReference(referenceValue);
        return runner.run(async (tx) => {
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "FulfillmentAsap:" + brand + ":" + store + ":" + reference,
          ]);
          const record = await read(tx, "submission_id", reference);
          if (record === null) return null;
          return work(tx, record);
        });
      });
    },
    append(value: unknown) {
      return safe(async () => {
        const raw = closed(value, ["record", "audit"]);
        const record = scoped(parseAsapCapacityCommitment(raw.record));
        const at = record.terminalAt ?? record.paymentRequestedAt ?? record.preparedAt;
        const now = parseFulfillmentInstant(clock.now());
        if (at > now) return fail("ASAP_CAPACITY_INVALID");
        const auditRaw = closed(raw.audit, [
          "auditId",
          "brandId",
          "storeId",
          "actor",
          "actionCode",
          "targetType",
          "targetId",
          "reasonCode",
          "correlationId",
          "occurredAt",
          "sourceChannel",
          "dataClassification",
          "retentionPolicyCode",
          "retentionPolicyVersion",
        ]);
        if (closed(auditRaw.actor, ["type"]).type !== "System")
          return fail("ASAP_CAPACITY_INVALID");
        const audit = validateAuditRecord(
          Object.freeze({ ...auditRaw, actor: Object.freeze({ type: "System" }) }) as never,
          Date.parse(now),
        );
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actionCode !== "FULFILLMENT_ASAP_CAPACITY_" + record.state.toUpperCase() ||
          audit.targetType !== "FulfillmentAsapCapacity" ||
          audit.targetId !== record.allocationReference ||
          audit.reasonCode !== "AUTHORIZED_CHECKOUT_CAPACITY" ||
          audit.occurredAt !== at ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted"
        )
          return fail("ASAP_CAPACITY_INVALID");
        return runner.run(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "FulfillmentAsap:" + brand + ":" + store + ":" + record.submissionReference,
          ]);
          const original = await read(tx, "submission_id", record.submissionReference, 1);
          if (original && original.allocationReference !== record.allocationReference)
            return fail("ASAP_CAPACITY_CONFLICT");
          const prior = await read(tx, "allocation_id", record.allocationReference, record.version);
          if (prior) {
            if (JSON.stringify(prior) !== JSON.stringify(record))
              return fail("ASAP_CAPACITY_CONFLICT");
            return Object.freeze({ status: "Existing" as const, record: prior });
          }
          const witness = row(
            await tx.query(insertRecord, [
              brand,
              store,
              record.slot.slotReference,
              record.slot.configVersion,
              record.allocationReference,
              record.guestSessionReference,
              record.cartReference,
              record.quoteReference,
              record.submissionReference,
              record.orderReference,
              record.orderBatchReference,
              record.fulfillmentReference,
              record.paymentOperationReference,
              record.cartVersion,
              record.units,
              record.unitsRuleVersion,
              record.unitsInputDigest,
              record.intentDigest,
              record.state,
              record.version,
              record.preparedAt,
              record.preparationValidUntil,
              record.orderingLinkedAt,
              record.paymentRequestedAt,
              record.capacityExpiresAt,
              record.terminalAt,
            ]),
          );
          if (
            witness === null ||
            closed(witness, ["reference"]).reference !== record.allocationReference
          )
            return fail();
          const saved = await read(tx, "allocation_id", record.allocationReference, record.version);
          if (saved === null || JSON.stringify(saved) !== JSON.stringify(record)) return fail();
          await appendAuditRecordInTransaction(tx, audit);
          return Object.freeze({ status: "Created" as const, record: saved });
        });
      });
    },
  });
}

/**
 * WP-2423 Q1: when each paid pickup Order stops being acceptable — the capacity expiry of its ASAP
 * commitment while that commitment is still PaymentPending (current version). Orders without one are
 * omitted. Caller authorizes the Store and owns the transaction.
 */
export async function listStorePickupAcceptanceDeadlines(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (orderReferences.length === 0) return new Map();
  if (orderReferences.length > 100) return fail();
  const brand = parseFulfillmentReference(scope.brandReference),
    store = parseFulfillmentReference(scope.storeReference),
    orders = orderReferences.map((value) => parseFulfillmentReference(value));
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const rows = (
    await tx.query(
      "SELECT a.order_id::text order_id,to_char(a.capacity_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') expires_at " +
        "FROM rms_fulfillment.capacity_asap_commitment a WHERE a.brand_id=$1 AND a.store_id=$2 AND a.order_id=ANY($3::uuid[]) " +
        "AND a.state='PaymentPending' AND NOT EXISTS (SELECT 1 FROM rms_fulfillment.capacity_asap_commitment b " +
        "WHERE b.brand_id=a.brand_id AND b.store_id=a.store_id AND b.allocation_id=a.allocation_id AND b.version>a.version)",
      [brand, store, orders],
    )
  ).rows;
  const deadlines = new Map<string, string>();
  for (const row of rows) {
    const order = parseFulfillmentReference(String(row.order_id)),
      expiresAt = parseFulfillmentInstant(String(row.expires_at));
    const known = deadlines.get(order);
    if (known === undefined || expiresAt < known) deadlines.set(order, expiresAt);
  }
  return deadlines;
}
