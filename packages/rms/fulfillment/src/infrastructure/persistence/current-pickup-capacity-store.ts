import { AsapCapacityError } from "../../domain/asap-capacity.js";
import {
  parseFulfillmentReference,
  parseFulfillmentInstant,
} from "../../domain/pickup-fulfillment.js";
import { parseScheduledCapacitySlot } from "../../domain/scheduled-capacity.js";
import type { AsapCapacityTransactionRunner } from "./asap-capacity-store.js";
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

const select = `SELECT jsonb_build_object(
 'slot',jsonb_build_object('brandReference',s.brand_id,'storeReference',s.store_id,
 'slotReference',s.slot_id,'fulfillmentType',s.fulfillment_type,'configVersion',c.config_version,
 'startsAt',to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'endsAt',to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'capacityLimit',CASE WHEN c.published_at<=$3::timestamptz THEN c.capacity_limit ELSE NULL END,'occupiedUnits',(
 SELECT coalesce(sum(units),0) FROM (
   SELECT h.capacity_units AS units FROM rms_fulfillment.capacity_hold h
   WHERE h.brand_id=s.brand_id AND h.store_id=s.store_id AND h.slot_id=s.slot_id
     AND h.expires_at>$3::timestamptz AND NOT EXISTS (
       SELECT 1 FROM rms_fulfillment.capacity_hold_terminal t
       WHERE t.brand_id=h.brand_id AND t.store_id=h.store_id AND t.hold_id=h.hold_id
         AND (t.terminal_state IN ('Released','Expired') OR EXISTS (
           SELECT 1 FROM rms_fulfillment.capacity_allocation a
           WHERE a.brand_id=h.brand_id AND a.store_id=h.store_id AND a.hold_id=h.hold_id)))
   UNION ALL
   SELECT h.capacity_units FROM rms_fulfillment.capacity_allocation a
   JOIN rms_fulfillment.capacity_hold h ON h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.hold_id=a.hold_id
   WHERE h.brand_id=s.brand_id AND h.store_id=s.store_id AND h.slot_id=s.slot_id
     AND NOT EXISTS (SELECT 1 FROM rms_fulfillment.capacity_allocation_terminal t
       WHERE t.brand_id=a.brand_id AND t.store_id=a.store_id AND t.allocation_id=a.allocation_id
         AND t.terminal_state='Released')
   UNION ALL
   SELECT a.capacity_units FROM rms_fulfillment.capacity_asap_commitment a
   WHERE a.brand_id=s.brand_id AND a.store_id=s.store_id AND a.slot_id=s.slot_id
     AND NOT EXISTS (SELECT 1 FROM rms_fulfillment.capacity_asap_commitment later
       WHERE later.brand_id=a.brand_id AND later.store_id=a.store_id
         AND later.allocation_id=a.allocation_id AND later.version>a.version)
     AND (a.state='Consumed' OR (a.state='Prepared' AND a.preparation_valid_until>$3::timestamptz)
       OR (a.state='PaymentPending' AND a.capacity_expires_at>$3::timestamptz))
 ) occupied
 ),'observedAt',to_char($3::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) AS observation
FROM rms_fulfillment.capacity_slot s
LEFT JOIN LATERAL (
 SELECT config_version,capacity_limit,published_at FROM rms_fulfillment.capacity_slot_configuration c
 WHERE c.brand_id=s.brand_id AND c.store_id=s.store_id AND c.slot_id=s.slot_id
 ORDER BY config_version DESC LIMIT 1
) c ON true
WHERE s.brand_id=$1 AND s.store_id=$2 AND s.fulfillment_type='Pickup'
 AND s.starts_at<=$3::timestamptz AND s.ends_at>$3::timestamptz
ORDER BY s.slot_id LIMIT 2`;
/** Current owner observation only; acquisition is enforced independently under the slot write lock. */
export function createPostgresCurrentPickupCapacityStore(
  runner: AsapCapacityTransactionRunner,
  scopeInput: unknown,
) {
  const scope = closed(scopeInput, ["brandReference", "storeReference"]);
  const brand = parseFulfillmentReference(scope.brandReference),
    store = parseFulfillmentReference(scope.storeReference);
  return Object.freeze({
    async resolve(observedAtValue: unknown) {
      try {
        const observedAt = parseFulfillmentInstant(observedAtValue);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          // row rejects two matches: overlapping current slots are not silently prioritized.
          const result = row(await tx.query(select, [brand, store, observedAt]));
          if (result === null) return fail();
          const raw = closed(closed(result, ["observation"]).observation, [
            "slot",
            "capacityLimit",
            "occupiedUnits",
            "observedAt",
          ]);
          const slot = parseScheduledCapacitySlot(raw.slot);
          if (
            slot.brandReference !== brand ||
            slot.storeReference !== store ||
            slot.fulfillmentType !== "Pickup" ||
            slot.startsAt > observedAt ||
            slot.endsAt <= observedAt ||
            parseFulfillmentInstant(raw.observedAt) !== observedAt ||
            !Number.isSafeInteger(raw.capacityLimit) ||
            (raw.capacityLimit as number) < 0 ||
            !Number.isSafeInteger(raw.occupiedUnits) ||
            (raw.occupiedUnits as number) < 0
          )
            return fail();
          return Object.freeze({
            slot,
            capacityLimit: raw.capacityLimit as number,
            occupiedUnits: raw.occupiedUnits as number,
            observedAt,
          });
        });
      } catch {
        return fail();
      }
    },
  });
}
