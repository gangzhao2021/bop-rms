import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import {
  parseStoreAdministrationReference,
  parseStoreServiceExceptions,
  type StoreServiceException,
} from "../../contracts/store-configuration-administration.js";
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const denied = (): never => {
  throw new Error("STORE_EXCEPTION_CONTENT_UNAVAILABLE");
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
/** Caller must fence authorization and current publication for this exact config.
 * No content header is not an empty exception. Digests require public owner proof.
 */
export function createPostgresStoreExceptionContentSource(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly configurationReference: string;
  authorize(tx: Transaction, observedAt: string): Promise<boolean>;
  verifyContent(
    tx: Transaction,
    input: {
      readonly exceptionReference: string;
      readonly summaryDigest: string;
      readonly exception: StoreServiceException;
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
        "LOCK TABLE rms_store.store_configuration_version,rms_store.store_service_exception,rms_store.store_service_exception_content,rms_store.store_service_exception_interval IN SHARE MODE",
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
      const parents = rows(
        await tx.query(
          "SELECT p.exception_id,p.local_date::text AS local_date,p.exception_kind,p.interval_summary_digest,c.interval_count FROM rms_store.store_service_exception p LEFT JOIN rms_store.store_service_exception_content c ON c.brand_id=p.brand_id AND c.store_id=p.store_id AND c.exception_id=p.exception_id WHERE p.brand_id=$1 AND p.store_id=$2 AND p.configuration_id=$3 ORDER BY p.local_date LIMIT 367",
          [brand, store, configuration],
        ),
        366,
      );
      const intervals = rows(
        await tx.query(
          "SELECT i.exception_id,i.sequence_number,i.start_local_time::text AS start_local_time,i.end_local_time::text AS end_local_time,i.ends_next_day,i.service_modes,i.order_cutoff_seconds,i.lead_time_seconds FROM rms_store.store_service_exception_interval i JOIN rms_store.store_service_exception p ON p.brand_id=i.brand_id AND p.store_id=i.store_id AND p.exception_id=i.exception_id WHERE p.brand_id=$1 AND p.store_id=$2 AND p.configuration_id=$3 ORDER BY p.local_date,i.sequence_number LIMIT 5857",
          [brand, store, configuration],
        ),
        5856,
      );
      let consumed = 0;
      const parsed = parseStoreServiceExceptions(
        parents.map((parent) => {
          parseStoreAdministrationReference(parent.exception_id);
          const count = parent.interval_count;
          if (
            typeof count !== "number" ||
            !Number.isInteger(count) ||
            count < 0 ||
            count > 16 ||
            typeof parent.interval_summary_digest !== "string" ||
            !/^sha256:[0-9a-f]{64}$/u.test(parent.interval_summary_digest)
          )
            return denied();
          const selected = intervals.filter((row) => row.exception_id === parent.exception_id);
          if (selected.length !== count) return denied();
          consumed += selected.length;
          return {
            localDate: parent.local_date,
            kind: parent.exception_kind,
            intervals: selected.map((row, index) => {
              if (row.sequence_number !== index + 1) return denied();
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
      if (consumed !== intervals.length) return denied();
      for (const [index, exception] of parsed.entries()) {
        const parent = parents[index];
        if (
          !parent ||
          parent.local_date !== exception.localDate ||
          (await options.verifyContent(tx, {
            exceptionReference: String(parent.exception_id),
            summaryDigest: String(parent.interval_summary_digest),
            exception,
            observedAt: at,
          })) !== true
        )
          return denied();
      }
      if ((await options.authorize(tx, at)) !== true) return denied();
      return parsed;
    } catch {
      return denied();
    }
  };
}
