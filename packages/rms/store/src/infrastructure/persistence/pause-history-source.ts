import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import { parseStoreAdministrationReference } from "../../contracts/store-configuration-administration.js";
import {
  parseStoreTemporaryClosures,
  type StoreTemporaryClosure,
} from "../../contracts/store-operating-status.js";

interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const denied = (): never => {
  throw new Error("STORE_PAUSE_HISTORY_UNAVAILABLE");
};
function instant(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return denied();
  return parseCanonicalInstant(value.toISOString());
}
function version(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return denied();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return denied();
  return parsed;
}
/** Internal owner read; proof attests operation intent/audit and content in this
 * transaction. Missing legacy content is unavailable, never inferred as resumed.
 */
export function createPostgresStorePauseHistorySource(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  authorize(tx: Transaction, at: string): Promise<boolean>;
  verifyOperation(
    tx: Transaction,
    operation: Readonly<Record<string, unknown>>,
    at: string,
  ): Promise<boolean>;
}) {
  const brand = parseBrandReference(options.brandReference);
  const store = parseStoreReference(options.storeReference);
  return async (tx: Transaction, now: string): Promise<readonly StoreTemporaryClosure[]> => {
    try {
      const at = parseCanonicalInstant(now);
      if ((await options.authorize(tx, at)) !== true) return denied();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await tx.query(
        "LOCK TABLE rms_store.store_configuration_operation,rms_store.store_service_pause_content,rms_store.store_service_resume_content IN SHARE MODE",
        [],
      );
      const result = await tx.query(
        "SELECT o.operation_id,o.configuration_id,o.command_type,o.intent_digest,o.expected_version,o.resulting_version,o.actor_reference,o.purpose_code,o.audit_reference,o.occurred_at,p.effective_from,p.effective_until,p.service_modes,r.pause_operation_id,r.effective_at FROM rms_store.store_configuration_operation o LEFT JOIN rms_store.store_service_pause_content p ON p.brand_id=o.brand_id AND p.store_id=o.store_id AND p.operation_id=o.operation_id LEFT JOIN rms_store.store_service_resume_content r ON r.brand_id=o.brand_id AND r.store_id=o.store_id AND r.operation_id=o.operation_id WHERE o.brand_id=$1 AND o.store_id=$2 AND o.command_type IN ('PauseService','ResumeService') AND o.occurred_at <= $3 ORDER BY o.occurred_at,o.operation_id LIMIT 10001",
        [brand, store, at],
      );
      if (!result || typeof result !== "object") return denied();
      const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !Array.isArray(descriptor.value) ||
        descriptor.value.length > 10000
      )
        return denied();
      const pauses = new Map<string, { closure: StoreTemporaryClosure; occurredAt: string }>();
      const resumes: { pause: string; effectiveAt: string; occurredAt: string }[] = [];
      for (const row of descriptor.value as Record<string, unknown>[]) {
        const operationReference = parseStoreAdministrationReference(row.operation_id);
        const occurredAt = instant(row.occurred_at);
        const expectedVersion = version(row.expected_version);
        const resultingVersion = version(row.resulting_version);
        if (
          resultingVersion <= expectedVersion ||
          occurredAt > at ||
          typeof row.intent_digest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/u.test(row.intent_digest) ||
          typeof row.purpose_code !== "string" ||
          !/^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(row.purpose_code)
        )
          return denied();
        let content: Readonly<Record<string, unknown>>;
        if (row.command_type === "PauseService") {
          const closure = parseStoreTemporaryClosures([
            {
              closureReference: operationReference,
              effectiveFrom: instant(row.effective_from),
              effectiveUntil: instant(row.effective_until),
              serviceModes: row.service_modes,
            },
          ])[0];
          if (!closure || closure.effectiveFrom < occurredAt || pauses.has(operationReference))
            return denied();
          pauses.set(operationReference, { closure, occurredAt });
          content = Object.freeze({ ...closure });
        } else if (row.command_type === "ResumeService") {
          const resume = {
            pause: parseStoreAdministrationReference(row.pause_operation_id),
            effectiveAt: instant(row.effective_at),
            occurredAt,
          };
          if (resume.effectiveAt < occurredAt) return denied();
          resumes.push(resume);
          content = Object.freeze({
            pauseOperationReference: resume.pause,
            effectiveAt: resume.effectiveAt,
          });
        } else return denied();
        if (
          (await options.verifyOperation(
            tx,
            Object.freeze({
              operationReference,
              brandReference: brand,
              storeReference: store,
              configurationReference: parseStoreAdministrationReference(row.configuration_id),
              command: row.command_type,
              intentDigest: row.intent_digest,
              expectedVersion,
              resultingVersion,
              actorReference: parseStoreAdministrationReference(row.actor_reference),
              purposeCode: row.purpose_code,
              auditReference: parseStoreAdministrationReference(row.audit_reference),
              occurredAt,
              content,
            }),
            at,
          )) !== true
        )
          return denied();
      }
      for (const resume of resumes) {
        const pause = pauses.get(resume.pause);
        if (
          !pause ||
          resume.occurredAt < pause.occurredAt ||
          resume.effectiveAt <= pause.closure.effectiveFrom
        )
          return denied();
        if (resume.effectiveAt < pause.closure.effectiveUntil) {
          pause.closure =
            parseStoreTemporaryClosures([
              {
                ...pause.closure,
                effectiveUntil: resume.effectiveAt,
              },
            ])[0] ?? denied();
        }
      }
      const active = [...pauses.values()]
        .map((value) => value.closure)
        .filter((closure) => closure.effectiveFrom <= at && at < closure.effectiveUntil)
        .sort(
          (a, b) =>
            a.effectiveFrom.localeCompare(b.effectiveFrom) ||
            a.closureReference.localeCompare(b.closureReference),
        );
      const parsed = parseStoreTemporaryClosures(active);
      if ((await options.authorize(tx, at)) !== true) return denied();
      return parsed;
    } catch {
      return denied();
    }
  };
}
