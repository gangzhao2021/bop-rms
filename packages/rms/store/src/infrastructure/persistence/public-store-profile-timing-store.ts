import {
  createEffectiveConfigurationVersion,
  createEffectivePeriodApprovalEvidence,
  deriveConfigurationStatus,
  sameEffectiveScope,
  validateNoEffectiveOverlap,
  type EffectiveConfigurationVersion,
  type EffectivePeriodApprovalEvidence,
  type EffectivePeriod,
} from "@bop/effective-period";
import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import { parseStoreAdministrationReference } from "../../contracts/store-configuration-administration.js";
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const fail = (): never => {
  throw new Error("STORE_PROFILE_TIMING_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function rows(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)) return fail();
  return descriptor.value;
}
/** Caller retains the transaction; callbacks retain current Tenant/purpose and
 * approval-authority fences. No raw supplied approval is trusted. This Store owner
 * records scheduling, not generic EffectivePeriod command intents or execution.
 */
export function createPostgresPublicStoreProfileTimingStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(tx: Transaction, at: string): Promise<boolean>;
  authorizeApproval(
    tx: Transaction,
    timing: EffectiveConfigurationVersion,
    approval: EffectivePeriodApprovalEvidence,
    at: string,
  ): Promise<boolean>;
  hashPeriod(period: EffectivePeriod): string;
  appendAudit(
    tx: Transaction,
    record: {
      timing: EffectiveConfigurationVersion;
      approval: EffectivePeriodApprovalEvidence;
      auditReference: string;
      recordedAt: string;
    },
  ): Promise<void>;
}) {
  const brand = parseBrandReference(options.brandReference);
  const store = parseStoreReference(options.storeReference);
  const allowed = async (tx: Transaction, at: string) => {
    if ((await options.authorize(tx, at)) !== true) return fail();
  };
  const fence = async (tx: Transaction, at: string, write: boolean) => {
    await allowed(tx, at);
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    await tx.query(
      write
        ? "LOCK TABLE rms_store.public_store_profile_timing IN SHARE ROW EXCLUSIVE MODE"
        : "LOCK TABLE rms_store.public_store_profile_timing IN SHARE MODE",
      [],
    );
  };
  function timing(value: EffectiveConfigurationVersion) {
    const result = createEffectiveConfigurationVersion(value);
    if (
      result.scope.kind !== "Store" ||
      result.scope.brandReference !== brand ||
      result.scope.storeReference !== store ||
      result.configurationType !== "STORE_PROFILE" ||
      result.purposeCode !== "CUSTOMER_ENTRY" ||
      options.hashPeriod(result.period) !== result.periodDigest
    )
      return fail();
    return result;
  }
  function approval(
    value: EffectivePeriodApprovalEvidence,
    version: EffectiveConfigurationVersion,
    at: string,
  ) {
    const result = createEffectivePeriodApprovalEvidence(value);
    if (
      result.evidenceReference !== version.approvalEvidenceReference ||
      result.familyReference !== version.familyReference ||
      result.timingVersionReference !== version.timingVersionReference ||
      result.version !== version.version ||
      !sameEffectiveScope(result.scope, version.scope) ||
      result.periodDigest !== version.periodDigest ||
      result.approvedAt > version.createdAt ||
      version.createdAt > at ||
      result.validUntil <= at
    )
      return fail();
    return result;
  }
  function saved(row: Record<string, unknown>) {
    const version = timing(row.timing_json as EffectiveConfigurationVersion);
    if (!(row.recorded_at instanceof Date)) return fail();
    const at = parseCanonicalInstant(row.recorded_at.toISOString());
    const evidence = approval(row.approval_json as EffectivePeriodApprovalEvidence, version, at);
    return {
      timing: version,
      approval: evidence,
      auditReference: parseStoreAdministrationReference(row.audit_reference),
      recordedAt: at,
    };
  }
  const loadFamily = async (tx: Transaction, family: string) =>
    rows(
      await tx.query(
        "SELECT timing_json,approval_json,audit_reference,recorded_at FROM rms_store.public_store_profile_timing WHERE brand_id=$1 AND store_id=$2 AND family_id=$3 ORDER BY timing_version",
        [brand, store, family],
      ),
    ).map(saved);
  return Object.freeze({
    async append(
      tx: Transaction,
      input: {
        timing: EffectiveConfigurationVersion;
        approval: EffectivePeriodApprovalEvidence;
        auditReference: string;
        recordedAt: string;
      },
    ) {
      const at = parseCanonicalInstant(input.recordedAt);
      const version = timing(input.timing);
      const evidence = approval(input.approval, version, at);
      const record = Object.freeze({
        timing: version,
        approval: evidence,
        auditReference: parseStoreAdministrationReference(input.auditReference),
        recordedAt: at,
      });
      await fence(tx, at, true);
      if ((await options.authorizeApproval(tx, version, evidence, at)) !== true) return fail();
      const prior = await loadFamily(tx, version.familyReference);
      const existing = prior.find((item) => item.timing.version === version.version);
      if (existing) {
        if (!equal(existing, record)) return fail();
        await allowed(tx, at);
        return "Existing" as const;
      }
      const last = prior.at(-1)?.timing;
      if (version.version !== (last?.version ?? 0) + 1) return fail();
      if (last) {
        for (const key of [
          "configurationReference",
          "releaseReference",
          "snapshotReference",
          "snapshotDigest",
        ] as const)
          if (last[key] !== version[key]) return fail();
        if (
          version.createdAt < last.createdAt ||
          version.timingVersionReference === last.timingVersionReference
        )
          return fail();
      }
      validateNoEffectiveOverlap(
        version,
        prior.map((item) => item.timing),
      );
      await tx.query(
        "INSERT INTO rms_store.public_store_profile_timing (brand_id,store_id,family_id,timing_id,timing_version,timing_json,approval_json,audit_reference,recorded_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)",
        [
          brand,
          store,
          version.familyReference,
          version.timingVersionReference,
          version.version,
          JSON.stringify(version),
          JSON.stringify(evidence),
          record.auditReference,
          at,
        ],
      );
      await options.appendAudit(tx, record);
      await allowed(tx, at);
      return "Created" as const;
    },
    async verify(tx: Transaction, value: EffectiveConfigurationVersion, now: string) {
      try {
        const at = parseCanonicalInstant(now);
        const version = timing(value);
        await fence(tx, at, false);
        const family = await loadFamily(tx, version.familyReference);
        const selected = family.filter(
          (item) =>
            item.recordedAt <= at && deriveConfigurationStatus(item.timing, at) === "Effective",
        );
        if (selected.length !== 1 || !equal(selected[0]?.timing, version)) return false;
        await allowed(tx, at);
        return true;
      } catch {
        return false;
      }
    },
  });
}
