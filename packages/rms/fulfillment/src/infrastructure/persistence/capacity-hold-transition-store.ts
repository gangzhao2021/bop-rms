import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  parseFulfillmentDigest,
  parseFulfillmentReference,
} from "../../domain/pickup-fulfillment.js";
import {
  parseScheduledCapacityHold,
  planScheduledCapacityConversion,
  planScheduledCapacityHoldRelease,
  ScheduledCapacityError,
  type ScheduledCapacityAllocation,
  type ScheduledCapacityHold,
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
WHERE h.brand_id=$1 AND h.store_id=$2 AND h.hold_id=$3`;

const receiptFields = [
  "brand",
  "store",
  "operation",
  "digest",
  "hold",
  "state",
  "at",
  "allocation",
  "order",
  "fulfillment",
  "allocationCreatedAt",
] as const;
const selectReceipt = `SELECT jsonb_build_object(
  'brand',t.brand_id,'store',t.store_id,'operation',t.operation_id,'digest',t.intent_digest,
  'hold',t.hold_id,'state',t.terminal_state,
  'at',to_char(t.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'allocation',t.allocation_id,'order',a.order_id,'fulfillment',a.fulfillment_id,
  'allocationCreatedAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) AS receipt
FROM rms_fulfillment.capacity_hold_terminal t
LEFT JOIN rms_fulfillment.capacity_allocation a
  ON a.brand_id=t.brand_id AND a.store_id=t.store_id AND a.hold_id=t.hold_id AND a.allocation_id=t.allocation_id
WHERE t.brand_id=$1 AND t.store_id=$2 AND t.operation_id=$3`;
const insertTerminal = `INSERT INTO rms_fulfillment.capacity_hold_terminal
 (brand_id,store_id,hold_id,terminal_state,allocation_id,operation_id,intent_digest,occurred_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING hold_id AS reference`;
const insertAllocation = `INSERT INTO rms_fulfillment.capacity_allocation
 (brand_id,store_id,allocation_id,hold_id,order_id,fulfillment_id,created_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING allocation_id AS reference`;

export interface CapacityHoldTransitionReceipt {
  readonly status: "Created" | "Existing";
  readonly hold: ScheduledCapacityHold;
  readonly allocation: ScheduledCapacityAllocation | null;
}

/** Authorized owner transitions. Receipts describe the original transition, not current Allocation authority. */
export function createPostgresCapacityHoldTransitionStore(
  runner: CapacityHoldWriteTransactionRunner,
  scope: unknown,
) {
  const fixed = input(() => {
    const raw = closed(scope, ["brandReference", "storeReference"]);
    return Object.freeze({
      brandReference: parseFulfillmentReference(raw.brandReference),
      storeReference: parseFulfillmentReference(raw.storeReference),
    });
  });
  const conflict = new Error();
  const transitionConflict = new Error();
  async function append(
    value: unknown,
    mode: "Convert" | "Release",
  ): Promise<CapacityHoldTransitionReceipt> {
    const request = input(() => {
      const raw = closed(value, ["transition", "operationReference", "intentDigest", "audit"]);
      const fields =
        mode === "Convert"
          ? [
              "hold",
              "scope",
              "expectedVersion",
              "at",
              "allocationReference",
              "orderReference",
              "fulfillmentReference",
            ]
          : ["hold", "scope", "expectedVersion", "at", "reason"];
      const transition = closed(raw.transition, fields);
      const original = parseScheduledCapacityHold(transition.hold);
      const planned =
        mode === "Convert"
          ? planScheduledCapacityConversion(transition)
          : { ...planScheduledCapacityHoldRelease(transition), allocation: null };
      if (
        original.slot.brandReference !== fixed.brandReference ||
        original.slot.storeReference !== fixed.storeReference
      )
        fail();
      const allocation = planned.allocation;
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
        Date.parse(planned.hold.updatedAt),
      );
      if (
        audit.brandId !== fixed.brandReference ||
        audit.storeId !== fixed.storeReference ||
        audit.targetId !== original.holdReference ||
        audit.targetType !== "FulfillmentCapacityHold" ||
        audit.actionCode !==
          (mode === "Convert"
            ? "FULFILLMENT_CAPACITY_HOLD_CONVERT"
            : "FULFILLMENT_CAPACITY_HOLD_RELEASE") ||
        audit.reasonCode !== "AUTHORIZED_CHECKOUT_CAPACITY" ||
        audit.occurredAt !== planned.hold.updatedAt ||
        audit.sourceChannel !== "CUSTOMER_PWA" ||
        audit.dataClassification !== "Restricted"
      )
        fail();
      return { original, hold: planned.hold, allocation, operation, digest, audit };
    });
    const { original, hold, allocation, operation, digest, audit } = request;
    const expected = {
      brand: fixed.brandReference,
      store: fixed.storeReference,
      operation,
      digest,
      hold: hold.holdReference,
      state: hold.state,
      at: hold.updatedAt,
      allocation: allocation?.allocationReference ?? null,
      order: allocation?.orderReference ?? null,
      fulfillment: allocation?.fulfillmentReference ?? null,
      allocationCreatedAt: allocation?.createdAt ?? null,
    };
    const encoded = JSON.stringify(expected);
    try {
      return await runner.run(async (tx) => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [fixed.brandReference, fixed.storeReference],
        );
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `fulfillment.capacity-hold-transition:${fixed.brandReference}:${fixed.storeReference}:${operation}`,
        ]);
        async function readReceipt() {
          const found = row(
            await tx.query(selectReceipt, [fixed.brandReference, fixed.storeReference, operation]),
          );
          if (found === null) return null;
          const receipt = closed(closed(found, ["receipt"]).receipt, receiptFields);
          if (
            receipt.brand !== fixed.brandReference ||
            receipt.store !== fixed.storeReference ||
            receipt.operation !== operation
          )
            fail();
          return JSON.stringify(receipt);
        }
        async function checkOriginal() {
          const found = row(
            await tx.query(selectOriginal, [
              fixed.brandReference,
              fixed.storeReference,
              original.holdReference,
            ]),
          );
          if (found === null) fail();
          const raw = closed(found, ["hold", "intentDigest"]);
          parseFulfillmentDigest(raw.intentDigest);
          const stored = parseScheduledCapacityHold(raw.hold);
          if (JSON.stringify(stored) !== JSON.stringify(original)) throw transitionConflict;
        }
        const prior = await readReceipt();
        if (prior !== null) {
          if (prior !== encoded) throw conflict;
          await checkOriginal();
          return Object.freeze({ status: "Existing" as const, hold, allocation });
        }
        const slot = row(
          await tx.query(
            `SELECT slot_id AS reference FROM rms_fulfillment.capacity_slot
          WHERE brand_id=$1 AND store_id=$2 AND slot_id=$3 FOR UPDATE`,
            [fixed.brandReference, fixed.storeReference, original.slot.slotReference],
          ),
        );
        if (slot === null || closed(slot, ["reference"]).reference !== original.slot.slotReference)
          fail();
        await checkOriginal();
        const terminal = row(
          await tx.query(
            `SELECT hold_id AS reference FROM rms_fulfillment.capacity_hold_terminal
          WHERE brand_id=$1 AND store_id=$2 AND hold_id=$3`,
            [fixed.brandReference, fixed.storeReference, hold.holdReference],
          ),
        );
        if (terminal !== null) {
          if (closed(terminal, ["reference"]).reference !== hold.holdReference) fail();
          throw transitionConflict;
        }
        const witness = row(
          await tx.query(insertTerminal, [
            fixed.brandReference,
            fixed.storeReference,
            hold.holdReference,
            hold.state,
            hold.allocationReference,
            operation,
            digest,
            hold.updatedAt,
          ]),
        );
        if (witness === null || closed(witness, ["reference"]).reference !== hold.holdReference)
          fail();
        if (allocation !== null) {
          const written = row(
            await tx.query(insertAllocation, [
              fixed.brandReference,
              fixed.storeReference,
              allocation.allocationReference,
              hold.holdReference,
              allocation.orderReference,
              allocation.fulfillmentReference,
              allocation.createdAt,
            ]),
          );
          if (
            written === null ||
            closed(written, ["reference"]).reference !== allocation.allocationReference
          )
            fail();
        }
        if ((await readReceipt()) !== encoded) fail();
        await appendAuditRecordInTransaction(tx, audit);
        return Object.freeze({ status: "Created" as const, hold, allocation });
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
  }
  return Object.freeze({
    convert: (value: unknown) => append(value, "Convert"),
    release: (value: unknown) => append(value, "Release"),
  });
}
