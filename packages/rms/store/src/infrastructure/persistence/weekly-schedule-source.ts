import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import {
  parseStoreAdministrationReference,
  parseStoreWeeklyServiceSchedule,
  type StoreWeeklyServiceDay,
} from "../../contracts/store-configuration-administration.js";

interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const denied = (): never => {
  throw new Error("STORE_WEEKLY_SCHEDULE_UNAVAILABLE");
};
function rows(value: unknown, maximum: number): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return denied();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.length > maximum
  )
    return denied();
  return descriptor.value;
}

/** Proof must attest the complete published week, including every empty day.
 * Caller fences current publication and authorization inside the supplied transaction.
 */
export function createPostgresStoreWeeklyScheduleSource(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly configurationReference: string;
  authorize(tx: Transaction, observedAt: string): Promise<boolean>;
  verifyContent(
    tx: Transaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly configurationReference: string;
      readonly weeklySchedule: readonly StoreWeeklyServiceDay[];
      readonly observedAt: string;
    },
  ): Promise<boolean>;
}) {
  const brand = parseBrandReference(options.brandReference);
  const store = parseStoreReference(options.storeReference);
  const configuration = parseStoreAdministrationReference(options.configurationReference);
  return async (tx: Transaction, now: string) => {
    try {
      const at = parseCanonicalInstant(now);
      if ((await options.authorize(tx, at)) !== true) return denied();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await tx.query(
        "LOCK TABLE rms_store.store_configuration_version,rms_store.store_weekly_service_period IN SHARE MODE",
        [],
      );
      const config = rows(
        await tx.query(
          "SELECT configuration_id FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 AND configuration_id=$3 AND lifecycle='Published' AND effective_from <= $4 AND (effective_until IS NULL OR effective_until > $4) AND created_at <= $4 AND updated_at <= $4",
          [brand, store, configuration, at],
        ),
        1,
      );
      if (config.length !== 1 || config[0]?.configuration_id !== configuration) return denied();
      const periods = rows(
        await tx.query(
          "SELECT iso_weekday,sequence_number,start_local_time::text AS start_local_time,end_local_time::text AS end_local_time,ends_next_day,service_modes,order_cutoff_seconds,lead_time_seconds FROM rms_store.store_weekly_service_period WHERE brand_id=$1 AND store_id=$2 AND configuration_id=$3 ORDER BY iso_weekday,sequence_number LIMIT 113",
          [brand, store, configuration],
        ),
        112,
      );
      let consumed = 0;
      const weeklySchedule = parseStoreWeeklyServiceSchedule(
        Array.from({ length: 7 }, (_, index) => {
          const selected = periods.filter((row) => row.iso_weekday === index + 1);
          consumed += selected.length;
          return {
            isoWeekday: index + 1,
            intervals: selected.map((row, sequence) => {
              if (row.sequence_number !== sequence + 1) return denied();
              return {
                startLocalTime: row.start_local_time,
                endLocalTime: row.end_local_time,
                endsNextDay: row.ends_next_day,
                serviceModes: row.service_modes,
                orderCutoffSeconds: row.order_cutoff_seconds,
                leadTimeSeconds: row.lead_time_seconds,
              };
            }),
          };
        }),
      );
      if (
        consumed !== periods.length ||
        (await options.verifyContent(tx, {
          brandReference: brand,
          storeReference: store,
          configurationReference: configuration,
          weeklySchedule,
          observedAt: at,
        })) !== true
      )
        return denied();
      if ((await options.authorize(tx, at)) !== true) return denied();
      return weeklySchedule;
    } catch {
      return denied();
    }
  };
}
