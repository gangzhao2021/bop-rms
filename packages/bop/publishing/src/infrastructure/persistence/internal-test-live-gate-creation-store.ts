/**
 * WP-2423 InternalTest only (DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 3b, coordinator
 * 2026-10-30, a test-environment-only shortcut): the Publishing owner's first launch gate of a TEST
 * Store opened in the product, so the InternalTest installation can serve it. It records version 1
 * of the `SYNTHETIC-STORE-LIVE-GATE` gate, Approved, with the one `SYNTHETIC_STORE_READY` requirement
 * accepted until the installation's validity end (at most 30 days ahead), and audits it with the
 * Owner's approval wording. A Store that already has any launch gate is refused; a real Store's
 * go-live check goes through its governed opening (B2), never through this.
 */
export interface InternalTestLiveGateCreationTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export class InternalTestLiveGateCreationError extends Error {
  constructor(
    readonly code:
      "INTERNAL_TEST_LIVE_GATE_INPUT_INVALID" | "INTERNAL_TEST_LIVE_GATE_ALREADY_EXISTS",
  ) {
    super(code);
    this.name = "InternalTestLiveGateCreationError";
  }
}
const fail = (code: InternalTestLiveGateCreationError["code"]): never => {
  throw new InternalTestLiveGateCreationError(code);
};
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_DAYS = 30;
const instant = (value: unknown) =>
  typeof value === "string" && INSTANT.test(value) && new Date(value).toISOString() === value;
export const internalTestLiveGateId = "SYNTHETIC-STORE-LIVE-GATE";
export const internalTestLiveGateRequirement = "SYNTHETIC_STORE_READY";

export interface InternalTestLiveGateCreationInput {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly gateReference: string;
  readonly decisionEvidenceReference: string;
  readonly requirementReference: string;
  readonly requirementEvidenceReference: string;
  /** Who submitted and who approved the gate: two different people (the database insists). */
  readonly submittedBy: string;
  readonly approvedBy: string;
  readonly validUntil: string;
  readonly at: string;
  readonly evidence: {
    readonly setupReference: string;
    readonly approvedBy: string;
    readonly approval: string;
    readonly reason: string;
    readonly operatorAccount: string;
  };
  readonly auditReference: string;
}

export async function createInternalTestLiveGate(
  tx: InternalTestLiveGateCreationTransaction,
  input: InternalTestLiveGateCreationInput,
  /** The platform Audit append (`appendAuditRecordInTransaction`) supplied by the composition. */
  appendAudit: (
    tx: InternalTestLiveGateCreationTransaction,
    record: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<{ readonly gateReference: string; readonly decisionEvidenceReference: string }> {
  const references = [
    input.tenantReference,
    input.brandReference,
    input.storeReference,
    input.gateReference,
    input.decisionEvidenceReference,
    input.requirementReference,
    input.requirementEvidenceReference,
    input.submittedBy,
    input.approvedBy,
    input.evidence.setupReference,
    input.auditReference,
  ];
  if (
    references.some((value) => typeof value !== "string" || !UUID_V7.test(value)) ||
    new Set(references.slice(3, 7)).size !== 4 ||
    input.submittedBy === input.approvedBy ||
    !instant(input.at) ||
    !instant(input.validUntil) ||
    input.validUntil <= input.at ||
    Date.parse(input.validUntil) > Date.parse(input.at) + MAX_DAYS * 86_400_000 ||
    [input.evidence.approvedBy, input.evidence.approval, input.evidence.reason].some(
      (value) => typeof value !== "string" || value.trim().length < 1 || value.length > 1000,
    ) ||
    typeof input.evidence.operatorAccount !== "string" ||
    input.evidence.operatorAccount.length > 200
  )
    fail("INTERNAL_TEST_LIVE_GATE_INPUT_INVALID");
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    input.brandReference,
    input.storeReference,
  ]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "bop_publishing.internal_test_live_gate:" + input.brandReference + ":" + input.storeReference,
  ]);
  const existing = (
    await tx.query(
      "SELECT 1 FROM bop_publishing.live_gate_version WHERE brand_id=$1 AND store_id=$2 LIMIT 1",
      [input.brandReference, input.storeReference],
    )
  ).rows;
  if (existing.length > 0) fail("INTERNAL_TEST_LIVE_GATE_ALREADY_EXISTS");
  await tx.query(
    `INSERT INTO bop_publishing.live_gate_version (gate_reference,gate_id,tenant_id,brand_id,store_id,gate_version,environment,state,
       owner_reference,submitted_by_reference,approved_by_reference,decision_evidence_reference,last_reviewed_at,changed_at,data_classification)
     VALUES ($1,$2,$3,$4,$5,1,'Production','Approved',$6,$7,$6,$8,$9,$9,'ConfigurationMetadata')`,
    [
      input.gateReference,
      internalTestLiveGateId,
      input.tenantReference,
      input.brandReference,
      input.storeReference,
      input.approvedBy,
      input.submittedBy,
      input.decisionEvidenceReference,
      input.at,
    ],
  );
  await tx.query(
    `INSERT INTO bop_publishing.live_gate_requirement (requirement_id,brand_id,store_id,gate_reference,gate_version,category_code,
       requirement_code,owner_reference,applicable,status,evidence_reference,evidence_version,valid_until,blocking_reason_code,data_classification)
     VALUES ($1,$2,$3,$4,1,'SYNTHETIC_TEST',$5,$6,true,'Accepted',$7,1,$8,NULL,'ConfigurationMetadata')`,
    [
      input.requirementReference,
      input.brandReference,
      input.storeReference,
      input.gateReference,
      internalTestLiveGateRequirement,
      input.approvedBy,
      input.requirementEvidenceReference,
      input.validUntil,
    ],
  );
  await appendAudit(tx, {
    auditId: input.auditReference,
    brandId: input.brandReference,
    storeId: input.storeReference,
    actor: { type: "System" },
    actionCode: "INTERNAL_TEST_LIVE_GATE_CREATED",
    targetType: "LiveGate",
    targetId: input.gateReference,
    afterSummary: {
      gateId: internalTestLiveGateId,
      gateVersion: 1,
      requirementCode: internalTestLiveGateRequirement,
      validUntil: input.validUntil,
      environment: "InternalTest",
      approvedBy: input.evidence.approvedBy,
      approval: input.evidence.approval,
      reason: input.evidence.reason,
      operatorAccount: input.evidence.operatorAccount,
    },
    reasonCode: "INTERNAL_TEST_STORE_SETUP",
    correlationId: input.evidence.setupReference,
    occurredAt: input.at,
    sourceChannel: "DEPLOYMENT",
    dataClassification: "Internal",
    retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
    retentionPolicyVersion: 1,
  });
  return Object.freeze({
    gateReference: input.gateReference,
    decisionEvidenceReference: input.decisionEvidenceReference,
  });
}
