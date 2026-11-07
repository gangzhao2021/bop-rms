import {
  parseScheduledCapacityAllocation,
  parseScheduledCapacityHold,
  ScheduledCapacityError,
  type ScheduledCapacityAllocation,
  type ScheduledCapacityHold,
} from "../../domain/scheduled-capacity.js";
import {
  parseFulfillmentDigest,
  parseFulfillmentReference,
} from "../../domain/pickup-fulfillment.js";

export interface CapacityQueryTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface CapacityQueryTransactionRunner {
  /** Use a dedicated transaction and clear local context before releasing the connection. */
  run<T>(action: (transaction: CapacityQueryTransaction) => Promise<T>): Promise<T>;
}

const selectHold = `SELECT jsonb_build_object(
  'slot', jsonb_build_object('brandReference',s.brand_id,'storeReference',s.store_id,
    'fulfillmentType',s.fulfillment_type,'slotReference',s.slot_id,'configVersion',h.config_version,
    'startsAt',to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'holdReference',h.hold_id,'cartReference',h.cart_id,'operationReference',h.operation_id,
  'units',h.capacity_units,'unitsRuleVersion',h.units_rule_version,'unitsInputDigest',h.units_input_digest,
  'state',coalesce(t.terminal_state,'Active'),'version',CASE WHEN t.hold_id IS NULL THEN 1 ELSE 2 END,
  'createdAt',to_char(h.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(coalesce(t.occurred_at,h.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',to_char(h.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'allocationReference',t.allocation_id
) AS hold, h.intent_digest AS "intentDigest"
FROM rms_fulfillment.capacity_hold h
JOIN rms_fulfillment.capacity_slot s
  ON s.brand_id=h.brand_id AND s.store_id=h.store_id AND s.slot_id=h.slot_id
LEFT JOIN rms_fulfillment.capacity_hold_terminal t
  ON t.brand_id=h.brand_id AND t.store_id=h.store_id AND t.hold_id=h.hold_id
WHERE h.brand_id=$1 AND h.store_id=$2`;

const selectAllocation = `SELECT jsonb_build_object(
  'slot',jsonb_build_object('brandReference',s.brand_id,'storeReference',s.store_id,
    'fulfillmentType',s.fulfillment_type,'slotReference',s.slot_id,'configVersion',h.config_version,
    'startsAt',to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'holdReference',h.hold_id,'cartReference',h.cart_id,'operationReference',h.operation_id,
  'units',h.capacity_units,'unitsRuleVersion',h.units_rule_version,'unitsInputDigest',h.units_input_digest,
  'allocationReference',a.allocation_id,'orderReference',a.order_id,'fulfillmentReference',a.fulfillment_id,
  'state',coalesce(t.terminal_state,'Active'),'version',CASE WHEN t.allocation_id IS NULL THEN 1 ELSE 2 END,
  'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(coalesce(t.occurred_at,a.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'consumedAt',to_char(t.consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) AS allocation
FROM rms_fulfillment.capacity_allocation a
JOIN rms_fulfillment.capacity_hold h
  ON h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.hold_id=a.hold_id
JOIN rms_fulfillment.capacity_slot s
  ON s.brand_id=h.brand_id AND s.store_id=h.store_id AND s.slot_id=h.slot_id
LEFT JOIN rms_fulfillment.capacity_allocation_terminal t
  ON t.brand_id=a.brand_id AND t.store_id=a.store_id AND t.allocation_id=a.allocation_id
WHERE a.brand_id=$1 AND a.store_id=$2 AND a.allocation_id=$3 AND a.order_id=$4 AND a.fulfillment_id=$5`;

function data(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new Error();
  const result: Record<string, unknown> = {};
  for (const field of fields) result[field] = data(value, field);
  return result;
}
function single(value: unknown): unknown | null {
  const rows = data(value, "rows");
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) throw new Error();
  const length = Object.getOwnPropertyDescriptor(rows, "length")?.value;
  if (length !== 0 && length !== 1) throw new Error();
  if (Reflect.ownKeys(rows).length !== length + 1) throw new Error();
  if (length === 0) return null;
  const row = data(rows, "0");
  if (row === null) throw new Error();
  return row;
}
function input<T>(work: () => T): T {
  try {
    return work();
  } catch {
    throw new ScheduledCapacityError("CAPACITY_INPUT_INVALID");
  }
}

/** Internal owner observations only. Callers authorize scope and revalidate current capacity for writes. */
export function createPostgresCapacityQueryStore(
  runner: CapacityQueryTransactionRunner,
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
  async function read<T>(
    sql: string,
    values: readonly unknown[],
    decode: (row: unknown) => T,
  ): Promise<T | null> {
    try {
      return await runner.run(async (transaction) => {
        await transaction.query("SET TRANSACTION READ ONLY", []);
        await transaction.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [fixed.brand, fixed.store],
        );
        const row = single(await transaction.query(sql, values));
        return row === null ? null : decode(row);
      });
    } catch (error) {
      throw new ScheduledCapacityError(
        error === conflict ? "CAPACITY_IDEMPOTENCY_CONFLICT" : "CAPACITY_DEPENDENCY_UNAVAILABLE",
      );
    }
  }
  function scopedHold(row: unknown): { hold: ScheduledCapacityHold; intentDigest: string } {
    const raw = closed(row, ["hold", "intentDigest"]);
    const hold = parseScheduledCapacityHold(raw.hold);
    const intentDigest = parseFulfillmentDigest(raw.intentDigest);
    if (hold.slot.brandReference !== fixed.brand || hold.slot.storeReference !== fixed.store)
      throw new Error();
    return { hold, intentDigest };
  }
  return Object.freeze({
    async loadHold(value: unknown): Promise<ScheduledCapacityHold | null> {
      const selector = input(() => {
        const raw = closed(value, ["holdReference", "cartReference"]);
        return {
          hold: parseFulfillmentReference(raw.holdReference),
          cart: parseFulfillmentReference(raw.cartReference),
        };
      });
      return read(
        selectHold + " AND h.hold_id=$3 AND h.cart_id=$4",
        Object.freeze([fixed.brand, fixed.store, selector.hold, selector.cart]),
        (row) => {
          const { hold } = scopedHold(row);
          if (hold.holdReference !== selector.hold || hold.cartReference !== selector.cart)
            throw new Error();
          return hold;
        },
      );
    },
    async resolveHoldOperation(value: unknown): Promise<ScheduledCapacityHold | null> {
      const selector = input(() => {
        const raw = closed(value, ["operationReference", "cartReference", "intentDigest"]);
        return {
          operation: parseFulfillmentReference(raw.operationReference),
          cart: parseFulfillmentReference(raw.cartReference),
          digest: parseFulfillmentDigest(raw.intentDigest),
        };
      });
      return read(
        selectHold + " AND h.operation_id=$3",
        Object.freeze([fixed.brand, fixed.store, selector.operation]),
        (row) => {
          const { hold, intentDigest } = scopedHold(row);
          if (hold.operationReference !== selector.operation) throw new Error();
          if (hold.cartReference !== selector.cart || intentDigest !== selector.digest)
            throw conflict;
          return hold;
        },
      );
    },
    async loadAllocation(value: unknown): Promise<ScheduledCapacityAllocation | null> {
      const selector = input(() => {
        const raw = closed(value, [
          "allocationReference",
          "orderReference",
          "fulfillmentReference",
        ]);
        return {
          allocation: parseFulfillmentReference(raw.allocationReference),
          order: parseFulfillmentReference(raw.orderReference),
          fulfillment: parseFulfillmentReference(raw.fulfillmentReference),
        };
      });
      return read(
        selectAllocation,
        Object.freeze([
          fixed.brand,
          fixed.store,
          selector.allocation,
          selector.order,
          selector.fulfillment,
        ]),
        (row) => {
          const allocation = parseScheduledCapacityAllocation(
            closed(row, ["allocation"]).allocation,
          );
          if (
            allocation.slot.brandReference !== fixed.brand ||
            allocation.slot.storeReference !== fixed.store ||
            allocation.allocationReference !== selector.allocation ||
            allocation.orderReference !== selector.order ||
            allocation.fulfillmentReference !== selector.fulfillment
          )
            throw new Error();
          return allocation;
        },
      );
    },
  });
}
