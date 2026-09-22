import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import { createLiveGateRecord, assertLiveGateReady } from "../../contracts/live-gate.js";
import { parsePublishingReference, parsePublishingCode } from "../../contracts/publishing.js";
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const denied = (): never => {
  throw new Error("LIVE_GATE_CURRENT_UNAVAILABLE");
};
function instant(value: unknown) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return denied();
  return value.toISOString();
}
function version(value: unknown) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return denied();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return denied();
  return number;
}
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
/** Required codes come from the authorized Store launch requirements, not request
 * input. authorize must fence current Tenant/Store association and read permission.
 */
export function createPostgresCurrentLiveGateSource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly decisionEvidenceReference: string;
  readonly requiredRequirementCodes: readonly string[];
  authorize(tx: Transaction, at: string): Promise<boolean>;
}) {
  const tenant = parsePublishingReference(options.tenantReference);
  const brand = parseBrandReference(options.brandReference);
  const store = parseStoreReference(options.storeReference);
  const decision = parsePublishingReference(options.decisionEvidenceReference);
  const required = options.requiredRequirementCodes.map(parsePublishingCode);
  if (!required.length || required.length > 1000 || new Set(required).size !== required.length)
    return denied();
  return async (tx: Transaction, now: string) => {
    try {
      const at = parseCanonicalInstant(now);
      if ((await options.authorize(tx, at)) !== true) return denied();
      await tx.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [tenant, brand, store],
      );
      await tx.query(
        "LOCK TABLE bop_publishing.live_gate_version,bop_publishing.live_gate_requirement IN SHARE MODE",
        [],
      );
      const candidates = rows(
        await tx.query(
          "SELECT DISTINCT gate_reference FROM bop_publishing.live_gate_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND decision_evidence_reference=$4 LIMIT 2",
          [tenant, brand, store, decision],
        ),
        2,
      );
      if (candidates.length !== 1) return denied();
      const gate = parsePublishingReference(candidates[0]?.gate_reference);
      const head = rows(
        await tx.query(
          "SELECT gate_reference,gate_id,gate_version,environment,state,owner_reference,submitted_by_reference,approved_by_reference,decision_evidence_reference,last_reviewed_at,changed_at FROM bop_publishing.live_gate_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND gate_reference=$4 ORDER BY gate_version DESC LIMIT 1",
          [tenant, brand, store, gate],
        ),
        1,
      )[0];
      if (
        !head ||
        head.state !== "Approved" ||
        head.decision_evidence_reference !== decision ||
        head.environment !== "Production" ||
        instant(head.changed_at) > at
      )
        return denied();
      const gateVersion = version(head.gate_version);
      const requirements = rows(
        await tx.query(
          "SELECT requirement_id,category_code,requirement_code,owner_reference,applicable,status,evidence_reference,evidence_version,valid_until,blocking_reason_code FROM bop_publishing.live_gate_requirement WHERE brand_id=$1 AND store_id=$2 AND gate_reference=$3 AND gate_version=$4 ORDER BY requirement_code LIMIT 1001",
          [brand, store, gate, gateVersion],
        ),
        1000,
      ).map((row) => ({
        requirementId: row.requirement_id,
        categoryCode: row.category_code,
        requirementCode: row.requirement_code,
        ownerReference: row.owner_reference,
        applicable: row.applicable,
        status: row.status,
        evidenceReference: row.evidence_reference,
        evidenceVersion: row.evidence_version === null ? null : version(row.evidence_version),
        validUntil: row.valid_until === null ? null : instant(row.valid_until),
        blockingReasonCode: row.blocking_reason_code,
      }));
      const record = createLiveGateRecord({
        gateReference: gate,
        gateId: head.gate_id,
        version: gateVersion,
        scope: {
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          environment: "Production",
        },
        state: head.state,
        ownerReference: head.owner_reference,
        requirements,
        submittedByReference: head.submitted_by_reference,
        approvedByReference: head.approved_by_reference,
        decisionEvidenceReference: head.decision_evidence_reference,
        lastReviewedAt: head.last_reviewed_at === null ? null : instant(head.last_reviewed_at),
        changedAt: instant(head.changed_at),
      });
      if (
        required.some((code) => !record.requirements.some((item) => item.requirementCode === code))
      )
        return denied();
      assertLiveGateReady(record, at);
      if ((await options.authorize(tx, at)) !== true) return denied();
      return record;
    } catch {
      return denied();
    }
  };
}
