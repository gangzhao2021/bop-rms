import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  parseFulfillmentDigest,
  parseFulfillmentReference,
} from "../../domain/pickup-fulfillment.js";
import {
  parseScheduledCapacityHold,
  ScheduledCapacityError,
  type ScheduledCapacityHold,
} from "../../domain/scheduled-capacity.js";

export interface CapacityHoldWriteTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface CapacityHoldWriteTransactionRunner {
  /** Dedicated transaction: commit only on success, rollback on failure, clear local context on release. */
  run<T>(action: (transaction: CapacityHoldWriteTransaction) => Promise<T>): Promise<T>;
}

function fail(): never {
  throw new ScheduledCapacityError("CAPACITY_DEPENDENCY_UNAVAILABLE");
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
function input<T>(work: () => T): T {
  try {
    return work();
  } catch {
    throw new ScheduledCapacityError("CAPACITY_INPUT_INVALID");
  }
}

const selectOriginal = `SELECT jsonb_build_object(
  'slot', jsonb_build_object('brandReference',s.brand_id,'storeReference',s.store_id,
    'fulfillmentType',s.fulfillment_type,'slotReference',s.slot_id,'configVersion',h.config_version,
    'startsAt',to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'holdReference',h.hold_id,'cartReference',h.cart_id,'operationReference',h.operation_id,
  'units',h.capacity_units,'unitsRuleVersion',h.units_rule_version,'unitsInputDigest',h.units_input_digest,
  'state','Active','version',1,
  'createdAt',to_char(h.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(h.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',to_char(h.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'allocationReference',NULL
) AS hold, h.intent_digest AS "intentDigest"
FROM rms_fulfillment.capacity_hold h
JOIN rms_fulfillment.capacity_slot s
  ON s.brand_id=h.brand_id AND s.store_id=h.store_id AND s.slot_id=h.slot_id
WHERE h.brand_id=$1 AND h.store_id=$2 AND h.operation_id=$3`;

const insert = `INSERT INTO rms_fulfillment.capacity_hold
 (brand_id,store_id,hold_id,slot_id,config_version,cart_id,operation_id,intent_digest,
 capacity_units,units_rule_version,units_input_digest,created_at,expires_at,data_classification)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'IndirectIdentifier')
 RETURNING hold_id AS reference`;

/** Internal authorized owner writes only. Returned Hold is original acquisition history, not current capacity. */
export function createPostgresCapacityHoldStore(
  runner: CapacityHoldWriteTransactionRunner,
  scope: unknown,
) {
  const fixed = input(() => {
    const raw = closed(scope, ["brandReference", "storeReference"]);
    return Object.freeze({
      brand: parseFulfillmentReference(raw.brandReference),
      store: parseFulfillmentReference(raw.storeReference),
    });
  });
  // Only this local sentinel can escape as a semantic conflict; dependency exceptions stay bounded.
  const conflict = new Error();
  return Object.freeze({
    async append(
      value: unknown,
    ): Promise<Readonly<{ status: "Created" | "Existing"; hold: ScheduledCapacityHold }>> {
      const request = input(() => {
        const raw = closed(value, ["hold", "intentDigest", "audit"]);
        const hold = parseScheduledCapacityHold(raw.hold);
        const intentDigest = parseFulfillmentDigest(raw.intentDigest);
        if (
          hold.state !== "Active" ||
          hold.slot.brandReference !== fixed.brand ||
          hold.slot.storeReference !== fixed.store
        )
          fail();
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
        if (
          closed(auditRaw.actor, ["type"]).type !== "System" ||
          Object.entries(auditRaw).some(
            ([key, v]) =>
              key !== "actor" &&
              (key === "retentionPolicyVersion" ? typeof v !== "number" : typeof v !== "string"),
          )
        )
          fail();
        const audit = validateAuditRecord(
          Object.freeze({ ...auditRaw, actor: Object.freeze({ type: "System" }) }),
          Date.parse(hold.createdAt),
        );
        if (
          audit.brandId !== fixed.brand ||
          audit.storeId !== fixed.store ||
          audit.actionCode !== "FULFILLMENT_CAPACITY_HOLD_CREATE" ||
          audit.targetType !== "FulfillmentCapacityHold" ||
          audit.targetId !== hold.holdReference ||
          audit.reasonCode !== "AUTHORIZED_CHECKOUT_CAPACITY" ||
          audit.occurredAt !== hold.createdAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted"
        )
          fail();
        return Object.freeze({ hold, intentDigest, audit });
      });
      const { hold, intentDigest, audit } = request;
      const encoded = JSON.stringify(hold);
      try {
        return await runner.run(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [fixed.brand, fixed.store],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `fulfillment.capacity-hold:${fixed.brand}:${fixed.store}:${hold.operationReference}`,
          ]);
          async function read() {
            const result = row(
              await tx.query(selectOriginal, [fixed.brand, fixed.store, hold.operationReference]),
            );
            if (result === null) return null;
            const raw = closed(result, ["hold", "intentDigest"]);
            const stored = parseScheduledCapacityHold(raw.hold);
            const digest = parseFulfillmentDigest(raw.intentDigest);
            if (
              stored.slot.brandReference !== fixed.brand ||
              stored.slot.storeReference !== fixed.store ||
              stored.operationReference !== hold.operationReference ||
              stored.state !== "Active"
            )
              fail();
            return { hold: stored, digest };
          }
          const prior = await read();
          if (prior !== null) {
            if (JSON.stringify(prior.hold) !== encoded || prior.digest !== intentDigest)
              throw conflict;
            return Object.freeze({ status: "Existing" as const, hold: prior.hold });
          }
          const witness = row(
            await tx.query(insert, [
              fixed.brand,
              fixed.store,
              hold.holdReference,
              hold.slot.slotReference,
              hold.slot.configVersion,
              hold.cartReference,
              hold.operationReference,
              intentDigest,
              hold.units,
              hold.unitsRuleVersion,
              hold.unitsInputDigest,
              hold.createdAt,
              hold.expiresAt,
            ]),
          );
          if (witness === null || closed(witness, ["reference"]).reference !== hold.holdReference)
            fail();
          const saved = await read();
          if (
            saved === null ||
            JSON.stringify(saved.hold) !== encoded ||
            saved.digest !== intentDigest
          )
            fail();
          await appendAuditRecordInTransaction(tx, audit);
          return Object.freeze({ status: "Created" as const, hold: saved.hold });
        });
      } catch (error) {
        throw new ScheduledCapacityError(
          error === conflict ? "CAPACITY_IDEMPOTENCY_CONFLICT" : "CAPACITY_DEPENDENCY_UNAVAILABLE",
        );
      }
    },
  });
}
