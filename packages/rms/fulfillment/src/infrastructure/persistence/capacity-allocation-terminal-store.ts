import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  parseFulfillmentDigest,
  parseFulfillmentInstant,
  parseFulfillmentReference,
} from "../../domain/pickup-fulfillment.js";
import {
  parseScheduledCapacityAllocation,
  planScheduledCapacityAllocationTransition,
  ScheduledCapacityError,
  type ScheduledCapacityAllocation,
} from "../../domain/scheduled-capacity.js";
import type { CapacityHoldWriteTransactionRunner } from "./capacity-hold-store.js";

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
  'slot',jsonb_build_object('brandReference',s.brand_id,'storeReference',s.store_id,
    'fulfillmentType',s.fulfillment_type,'slotReference',s.slot_id,'configVersion',h.config_version,
    'startsAt',to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'holdReference',h.hold_id,'cartReference',h.cart_id,'operationReference',h.operation_id,
  'units',h.capacity_units,'unitsRuleVersion',h.units_rule_version,'unitsInputDigest',h.units_input_digest,
  'allocationReference',a.allocation_id,'orderReference',a.order_id,'fulfillmentReference',a.fulfillment_id,
  'state','Active','version',1,
  'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'consumedAt',NULL
) AS allocation
FROM rms_fulfillment.capacity_allocation a
JOIN rms_fulfillment.capacity_hold h
  ON h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.hold_id=a.hold_id
JOIN rms_fulfillment.capacity_slot s
  ON s.brand_id=h.brand_id AND s.store_id=h.store_id AND s.slot_id=h.slot_id
WHERE a.brand_id=$1 AND a.store_id=$2 AND a.allocation_id=$3 AND a.order_id=$4 AND a.fulfillment_id=$5`;

const receiptFields = [
  "brand",
  "store",
  "operation",
  "digest",
  "allocation",
  "state",
  "at",
  "inProgressAt",
  "consumedAt",
] as const;
const selectReceipt = `SELECT jsonb_build_object(
 'brand',brand_id,'store',store_id,'operation',operation_id,'digest',intent_digest,'allocation',allocation_id,
 'state',terminal_state,
 'at',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'inProgressAt',to_char(fulfillment_in_progress_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'consumedAt',to_char(consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) AS receipt FROM rms_fulfillment.capacity_allocation_terminal
WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`;
const insert = `INSERT INTO rms_fulfillment.capacity_allocation_terminal
 (brand_id,store_id,allocation_id,terminal_state,operation_id,intent_digest,occurred_at,fulfillment_in_progress_at,consumed_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING allocation_id AS reference`;

/** Owner-only persistence. Current authorized progress must be established by the caller; null is not a fallback. */
export function createPostgresCapacityAllocationTerminalStore(
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
  const conflict = new Error();
  const transitionConflict = new Error();
  return Object.freeze({
    async append(
      value: unknown,
    ): Promise<
      Readonly<{ status: "Created" | "Existing"; allocation: ScheduledCapacityAllocation }>
    > {
      const request = input(() => {
        const raw = closed(value, ["transition", "operationReference", "intentDigest", "audit"]);
        const transition = closed(raw.transition, [
          "allocation",
          "scope",
          "expectedVersion",
          "at",
          "action",
          "fulfillmentInProgressAt",
        ]);
        const original = parseScheduledCapacityAllocation(transition.allocation);
        const allocation = planScheduledCapacityAllocationTransition(transition).allocation;
        if (
          original.slot.brandReference !== fixed.brand ||
          original.slot.storeReference !== fixed.store
        )
          fail();
        const inProgressAt =
          transition.fulfillmentInProgressAt === null
            ? null
            : parseFulfillmentInstant(transition.fulfillmentInProgressAt);
        const operation = parseFulfillmentReference(raw.operationReference);
        const digest = parseFulfillmentDigest(raw.intentDigest);
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
          Date.parse(allocation.updatedAt),
        );
        if (
          audit.brandId !== fixed.brand ||
          audit.storeId !== fixed.store ||
          audit.targetId !== allocation.allocationReference ||
          audit.targetType !== "FulfillmentCapacityAllocation" ||
          audit.actionCode !==
            (allocation.state === "Consumed"
              ? "FULFILLMENT_CAPACITY_ALLOCATION_CONSUME"
              : "FULFILLMENT_CAPACITY_ALLOCATION_RELEASE") ||
          audit.reasonCode !== "AUTHORIZED_CAPACITY_TRANSITION" ||
          audit.occurredAt !== allocation.updatedAt ||
          !["CUSTOMER_PWA", "EVENT_CONSUMER"].includes(audit.sourceChannel) ||
          audit.dataClassification !== "Restricted"
        )
          fail();
        return { original, allocation, inProgressAt, operation, digest, audit };
      });
      const { original, allocation, inProgressAt, operation, digest, audit } = request;
      const expected = JSON.stringify({
        brand: fixed.brand,
        store: fixed.store,
        operation,
        digest,
        allocation: allocation.allocationReference,
        state: allocation.state,
        at: allocation.updatedAt,
        inProgressAt,
        consumedAt: allocation.consumedAt,
      });
      try {
        return await runner.run(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [fixed.brand, fixed.store],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `fulfillment.capacity-allocation-terminal:${fixed.brand}:${fixed.store}:${operation}`,
          ]);
          async function receipt() {
            const found = row(await tx.query(selectReceipt, [fixed.brand, fixed.store, operation]));
            if (found === null) return null;
            const result = closed(closed(found, ["receipt"]).receipt, receiptFields);
            if (
              result.brand !== fixed.brand ||
              result.store !== fixed.store ||
              result.operation !== operation
            )
              fail();
            return JSON.stringify(result);
          }
          async function checkOriginal() {
            const found = row(
              await tx.query(selectOriginal, [
                fixed.brand,
                fixed.store,
                original.allocationReference,
                original.orderReference,
                original.fulfillmentReference,
              ]),
            );
            if (found === null) fail();
            const saved = parseScheduledCapacityAllocation(
              closed(found, ["allocation"]).allocation,
            );
            if (JSON.stringify(saved) !== JSON.stringify(original)) throw transitionConflict;
          }
          const prior = await receipt();
          if (prior !== null) {
            if (prior !== expected) throw conflict;
            await checkOriginal();
            return Object.freeze({ status: "Existing" as const, allocation });
          }
          const slot = row(
            await tx.query(
              `SELECT slot_id AS reference FROM rms_fulfillment.capacity_slot
       WHERE brand_id=$1 AND store_id=$2 AND slot_id=$3 FOR UPDATE`,
              [fixed.brand, fixed.store, original.slot.slotReference],
            ),
          );
          if (
            slot === null ||
            closed(slot, ["reference"]).reference !== original.slot.slotReference
          )
            fail();
          await checkOriginal();
          const terminal = row(
            await tx.query(
              `SELECT allocation_id AS reference FROM rms_fulfillment.capacity_allocation_terminal
       WHERE brand_id=$1 AND store_id=$2 AND allocation_id=$3`,
              [fixed.brand, fixed.store, allocation.allocationReference],
            ),
          );
          if (terminal !== null) {
            if (closed(terminal, ["reference"]).reference !== allocation.allocationReference)
              fail();
            throw transitionConflict;
          }
          const witness = row(
            await tx.query(insert, [
              fixed.brand,
              fixed.store,
              allocation.allocationReference,
              allocation.state,
              operation,
              digest,
              allocation.updatedAt,
              inProgressAt,
              allocation.consumedAt,
            ]),
          );
          if (
            witness === null ||
            closed(witness, ["reference"]).reference !== allocation.allocationReference
          )
            fail();
          if ((await receipt()) !== expected) fail();
          await appendAuditRecordInTransaction(tx, audit);
          return Object.freeze({ status: "Created" as const, allocation });
        });
      } catch (error) {
        throw new ScheduledCapacityError(
          error === conflict
            ? "CAPACITY_IDEMPOTENCY_CONFLICT"
            : error === transitionConflict
              ? "CAPACITY_TRANSITION_CONFLICT"
              : "CAPACITY_DEPENDENCY_UNAVAILABLE",
        );
      }
    },
  });
}
