import type { AuditTransaction } from "@bop/audit";
import {
  parseFulfillmentInstant,
  parseFulfillmentReference,
} from "../../domain/pickup-fulfillment.js";
import {
  PickupCapacityScheduleError,
  pickupCapacityCoverageEnd,
  planPickupCapacitySchedule,
  type PickupCapacityExistingSlot,
  type PickupCapacityPolicy,
} from "../../domain/pickup-capacity-schedule.js";

/**
 * WP-2423 (DEC-PICKUP-CAPACITY-SCHEDULE): owner persistence of the rolling pickup capacity
 * schedule. One transaction per run, serialized per Store by a transaction advisory lock so two
 * workers (a restart overlap) never lay overlapping slots. A capacity version is published only
 * after the slot row is locked — the same lock every hold and ASAP commitment takes — and only
 * when the slot still has no reservation, so a checkout racing the run keeps the version it saw.
 */
export interface PickupCapacityScheduleTransactionRunner {
  run<T>(action: (transaction: AuditTransaction) => Promise<T>): Promise<T>;
}

export interface PickupCapacityScheduleRun {
  readonly observedAt: string;
  readonly horizonUntil: string;
  readonly timeZone: string;
  readonly serviceWindows: readonly Readonly<{ startsAt: string; endsAt: string }>[];
  readonly businessDays: readonly Readonly<{
    businessDate: string;
    startsAt: string;
    endsAt: string;
  }>[];
  readonly policy: PickupCapacityPolicy;
  /** A fresh UUIDv7 per new slot. */
  generateReference(): string;
}

export interface PickupCapacityScheduleResult {
  readonly created: number;
  readonly republished: number;
  readonly keptReserved: number;
  readonly coveredUntil: string;
}

function fail(): never {
  throw new PickupCapacityScheduleError("PICKUP_CAPACITY_SCHEDULE_INPUT_INVALID");
}

function scopeOf(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "brandReference,storeReference") return fail();
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    brand: parseFulfillmentReference(raw.brandReference),
    store: parseFulfillmentReference(raw.storeReference),
  });
}

const instantSql = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const reservedSql = `(EXISTS (SELECT 1 FROM rms_fulfillment.capacity_hold h
    WHERE h.brand_id=s.brand_id AND h.store_id=s.store_id AND h.slot_id=s.slot_id)
  OR EXISTS (SELECT 1 FROM rms_fulfillment.capacity_asap_commitment a
    WHERE a.brand_id=s.brand_id AND a.store_id=s.store_id AND a.slot_id=s.slot_id))`;

const selectSlots = `SELECT s.slot_id::text AS "slotReference",
  ${instantSql("s.starts_at")} AS "startsAt", ${instantSql("s.ends_at")} AS "endsAt",
  coalesce(c.config_version,0)::integer AS "configVersion", c.capacity_limit::integer AS "capacityLimit",
  ${reservedSql} AS reserved
FROM rms_fulfillment.capacity_slot s
LEFT JOIN LATERAL (
  SELECT config_version, capacity_limit FROM rms_fulfillment.capacity_slot_configuration c
  WHERE c.brand_id=s.brand_id AND c.store_id=s.store_id AND c.slot_id=s.slot_id
  ORDER BY config_version DESC LIMIT 1) c ON true
WHERE s.brand_id=$1 AND s.store_id=$2 AND s.fulfillment_type='Pickup'
  AND s.ends_at>$3::timestamptz AND s.starts_at<$4::timestamptz
ORDER BY s.starts_at, s.ends_at LIMIT 5001`;

function slotRows(result: unknown): PickupCapacityExistingSlot[] {
  const rows = (result as { rows?: unknown })?.rows;
  if (!Array.isArray(rows) || rows.length > 5000) return fail();
  return rows.map((row: Record<string, unknown>) => {
    if (row === null || typeof row !== "object") return fail();
    return Object.freeze({
      slotReference: parseFulfillmentReference(row.slotReference),
      startsAt: parseFulfillmentInstant(row.startsAt),
      endsAt: parseFulfillmentInstant(row.endsAt),
      configVersion: Number(row.configVersion),
      capacityLimit: row.capacityLimit === null ? null : Number(row.capacityLimit),
      reserved: row.reserved === true,
    });
  });
}

async function enter(tx: AuditTransaction, brand: string, store: string) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
}

export function createPostgresPickupCapacityScheduleStore(
  runner: PickupCapacityScheduleTransactionRunner,
  scopeInput: unknown,
) {
  const { brand, store } = scopeOf(scopeInput);
  return Object.freeze({
    /** Fill the schedule to the horizon and follow current hours on unreserved future slots. */
    async apply(input: PickupCapacityScheduleRun): Promise<PickupCapacityScheduleResult> {
      const observedAt = parseFulfillmentInstant(input.observedAt);
      const horizonUntil = parseFulfillmentInstant(input.horizonUntil);
      if (typeof input.generateReference !== "function") return fail();
      return runner.run(async (tx) => {
        await enter(tx, brand, store);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `rms_fulfillment.pickup_capacity_schedule:${brand}:${store}`,
        ]);
        const existing = slotRows(
          await tx.query(selectSlots, [brand, store, observedAt, horizonUntil]),
        );
        const plan = planPickupCapacitySchedule({
          observedAt,
          horizonUntil,
          timeZone: input.timeZone,
          serviceWindows: input.serviceWindows,
          businessDays: input.businessDays,
          existingSlots: existing,
          policy: input.policy,
        });
        // Never after the database clock (the version trigger), never after observedAt (readers).
        const publishedAt = `LEAST($1::timestamptz,date_trunc('milliseconds',clock_timestamp()))`;
        for (const slot of plan.create) {
          const slotReference = parseFulfillmentReference(input.generateReference());
          await tx.query(
            `INSERT INTO rms_fulfillment.capacity_slot
             (brand_id,store_id,slot_id,fulfillment_type,starts_at,ends_at,time_zone,business_date)
             VALUES ($1,$2,$3,'Pickup',$4,$5,$6,$7::date)`,
            [
              brand,
              store,
              slotReference,
              slot.startsAt,
              slot.endsAt,
              input.timeZone,
              slot.businessDate,
            ],
          );
          await tx.query(
            `INSERT INTO rms_fulfillment.capacity_slot_configuration
             (brand_id,store_id,slot_id,config_version,capacity_limit,published_at)
             VALUES ($2,$3,$4,1,$5,${publishedAt})`,
            [observedAt, brand, store, slotReference, slot.capacityLimit],
          );
        }
        let republished = 0,
          keptReserved = 0;
        for (const change of plan.republish) {
          // The slot lock serializes with holds and ASAP commitments; re-read under it.
          const current = await tx.query(
            `SELECT coalesce((SELECT max(config_version) FROM rms_fulfillment.capacity_slot_configuration c
               WHERE c.brand_id=s.brand_id AND c.store_id=s.store_id AND c.slot_id=s.slot_id),0)::integer AS version,
               ${reservedSql} AS reserved, s.starts_at>$4::timestamptz AS future
             FROM rms_fulfillment.capacity_slot s
             WHERE s.brand_id=$1 AND s.store_id=$2 AND s.slot_id=$3 FOR UPDATE OF s`,
            [brand, store, change.slotReference, observedAt],
          );
          const row = (current as { rows?: Record<string, unknown>[] }).rows?.[0];
          if (row === undefined) return fail();
          if (
            row.reserved === true ||
            row.future !== true ||
            Number(row.version) !== change.previousVersion
          ) {
            keptReserved += 1;
            continue;
          }
          await tx.query(
            `INSERT INTO rms_fulfillment.capacity_slot_configuration
             (brand_id,store_id,slot_id,config_version,capacity_limit,published_at)
             VALUES ($2,$3,$4,$5,$6,${publishedAt})`,
            [
              observedAt,
              brand,
              store,
              change.slotReference,
              change.configVersion,
              change.capacityLimit,
            ],
          );
          republished += 1;
        }
        return Object.freeze({
          created: plan.create.length,
          republished,
          keptReserved,
          coveredUntil: plan.coveredUntil,
        });
      });
    },

    /** End of the Store's gap-free pickup capacity coverage from observedAt (ops horizon alert). */
    async coverage(
      observedAtValue: unknown,
    ): Promise<Readonly<{ observedAt: string; coveredUntil: string }>> {
      const observedAt = parseFulfillmentInstant(observedAtValue);
      return runner.run(async (tx) => {
        await enter(tx, brand, store);
        const until = new Date(Date.parse(observedAt) + 62 * 86_400_000).toISOString();
        const slots = slotRows(await tx.query(selectSlots, [brand, store, observedAt, until]));
        return Object.freeze({
          observedAt,
          coveredUntil: pickupCapacityCoverageEnd(slots, observedAt),
        });
      });
    },
  });
}
