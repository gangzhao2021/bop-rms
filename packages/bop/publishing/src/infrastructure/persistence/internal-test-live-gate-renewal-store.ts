/**
 * WP-2423 InternalTest only: the Publishing owner's Owner-approved renewal of a synthetic Store
 * launch gate's accepted requirement validity. Live Gate history is append-only, so the renewal
 * appends the next gate version: the same gate, state, owner, submitter, approver, decision
 * evidence and review instant, with every requirement copied unchanged except a `valid_until`
 * equal to the installation's common expiry, which becomes the approved new end (at most 30 days
 * ahead). It is audited per moved requirement (before → after, approval). Only an Approved gate
 * whose id is `SYNTHETIC-…` and whose requirements are all `SYNTHETIC_…` (code and category) is
 * renewed; any other gate with an accepted requirement at that expiry refuses the whole renewal.
 * A gate whose current version already carries the new end is left as it is.
 */
export interface InternalTestLiveGateTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export class InternalTestLiveGateRenewalError extends Error {
  constructor(
    readonly code:
      | "INTERNAL_TEST_LIVE_GATE_INPUT_INVALID"
      | "INTERNAL_TEST_LIVE_GATE_NOT_SYNTHETIC"
      | "INTERNAL_TEST_LIVE_GATE_CONFLICT",
  ) {
    super(code);
    this.name = "InternalTestLiveGateRenewalError";
  }
}
const fail = (code: InternalTestLiveGateRenewalError["code"]): never => {
  throw new InternalTestLiveGateRenewalError(code);
};
const SYNTHETIC = /^[0-9a-f]{8}-0000-7000-8000-[0-9a-f]{12}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SYNTHETIC_CODE = /^SYNTHETIC_[A-Z0-9_]+$/u;
const MAX_DAYS = 30;
const instant = (value: unknown) =>
  typeof value === "string" && INSTANT.test(value) && new Date(value).toISOString() === value;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);

export interface InternalTestLiveGateRenewalInput {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly evidence: {
    readonly renewalReference: string;
    readonly approvedBy: string;
    readonly approval: string;
    readonly reason: string;
    readonly operatorAccount: string;
  };
  readonly nextReference: () => string;
  /**
   * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (InternalTest only): the Store is a TEST Store the
   * Owner opened in the product, which the caller confirmed (its opening record and TEST label):
   * its own and its gate's references are ordinary ones, not fixture identities. Everything else
   * (synthetic gate id, codes and categories, the Tenant and Brand) is checked as for any Store.
   */
  readonly testStoreOpenedInProduct?: true;
}
export interface InternalTestLiveGateRenewal {
  readonly gateReference: string;
  readonly gateId: string;
  readonly decisionEvidenceReference: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly requirements: readonly {
    readonly requirementCode: string;
    readonly from: string;
    readonly to: string;
  }[];
}

const versionColumns =
  "gate_reference,gate_id,tenant_id,brand_id,store_id,gate_version,environment,state,owner_reference,submitted_by_reference,approved_by_reference,decision_evidence_reference,last_reviewed_at,changed_at,data_classification";

/** Renews the synthetic launch gates of one Store; see the module note. */
export async function renewInternalTestLiveGates(
  tx: InternalTestLiveGateTransaction,
  input: InternalTestLiveGateRenewalInput,
  /** The platform Audit append (`appendAuditRecordInTransaction`) supplied by the composition. */
  appendAudit: (
    tx: InternalTestLiveGateTransaction,
    record: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<{
  readonly renewed: readonly InternalTestLiveGateRenewal[];
  readonly alreadyRenewed: number;
  /** Every synthetic gate examined (renewed or already renewed), for the caller's read check. */
  readonly gates: readonly {
    readonly gateReference: string;
    readonly decisionEvidenceReference: string;
  }[];
}> {
  const opened = input.testStoreOpenedInProduct === true;
  if (
    !SYNTHETIC.test(input.brandReference) ||
    !(SYNTHETIC.test(input.storeReference) || (opened && UUID_V7.test(input.storeReference))) ||
    !instant(input.from) ||
    !instant(input.to) ||
    !instant(input.at) ||
    input.to < input.from ||
    input.to <= input.at ||
    Date.parse(input.to) > Date.parse(input.at) + MAX_DAYS * 86_400_000 ||
    !UUID_V7.test(input.evidence.renewalReference) ||
    typeof input.nextReference !== "function"
  )
    fail("INTERNAL_TEST_LIVE_GATE_INPUT_INVALID");
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    input.brandReference,
    input.storeReference,
  ]);
  // One renewal per Store at a time; a concurrent new gate version still collides on its key.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "bop_publishing.internal_test_live_gate:" + input.brandReference + ":" + input.storeReference,
  ]);
  // Current version of every gate of the Store with an accepted requirement at either instant.
  const heads = (
    await tx.query(
      `SELECT ${versionColumns} FROM (
         SELECT DISTINCT ON (gate_reference) * FROM bop_publishing.live_gate_version
         WHERE brand_id=$1 AND store_id=$2 ORDER BY gate_reference,gate_version DESC) h
       WHERE EXISTS (SELECT 1 FROM bop_publishing.live_gate_requirement q WHERE q.brand_id=h.brand_id AND q.store_id=h.store_id
         AND q.gate_reference=h.gate_reference AND q.gate_version=h.gate_version AND q.status='Accepted'
         AND q.valid_until IN ($3::timestamptz,$4::timestamptz))
       ORDER BY gate_reference LIMIT 11`,
      [input.brandReference, input.storeReference, input.from, input.to],
    )
  ).rows;
  if (heads.length > 10) fail("INTERNAL_TEST_LIVE_GATE_NOT_SYNTHETIC");
  const renewed: InternalTestLiveGateRenewal[] = [];
  let alreadyRenewed = 0;
  const gates: { gateReference: string; decisionEvidenceReference: string }[] = [];
  for (const head of heads) {
    const requirements = (
      await tx.query(
        `SELECT requirement_id::text id,category_code,requirement_code,owner_reference,applicable,status,evidence_reference,
           evidence_version,valid_until,blocking_reason_code,data_classification
         FROM bop_publishing.live_gate_requirement WHERE brand_id=$1 AND store_id=$2 AND gate_reference=$3 AND gate_version=$4
         ORDER BY requirement_code LIMIT 101`,
        [input.brandReference, input.storeReference, head.gate_reference, head.gate_version],
      )
    ).rows;
    if (
      typeof head.gate_id !== "string" ||
      !head.gate_id.startsWith("SYNTHETIC-") ||
      typeof head.tenant_id !== "string" ||
      !SYNTHETIC.test(head.tenant_id) ||
      typeof head.gate_reference !== "string" ||
      !(SYNTHETIC.test(head.gate_reference) || (opened && UUID_V7.test(head.gate_reference))) ||
      head.state !== "Approved" ||
      requirements.length < 1 ||
      requirements.length > 100 ||
      requirements.some(
        (row) =>
          typeof row.requirement_code !== "string" ||
          !SYNTHETIC_CODE.test(row.requirement_code) ||
          typeof row.category_code !== "string" ||
          !SYNTHETIC_CODE.test(row.category_code),
      )
    )
      fail("INTERNAL_TEST_LIVE_GATE_NOT_SYNTHETIC");
    const moved = requirements.filter(
      (row) => row.status === "Accepted" && iso(row.valid_until) === input.from,
    );
    gates.push({
      gateReference: String(head.gate_reference),
      decisionEvidenceReference: String(head.decision_evidence_reference),
    });
    if (moved.length === 0 || input.from === input.to) {
      alreadyRenewed += 1;
      continue;
    }
    const fromVersion = Number(head.gate_version);
    const toVersion = fromVersion + 1;
    const inserted = (
      await tx.query(
        `INSERT INTO bop_publishing.live_gate_version (${versionColumns})
         SELECT gate_reference,gate_id,tenant_id,brand_id,store_id,$5::bigint,environment,state,owner_reference,submitted_by_reference,
           approved_by_reference,decision_evidence_reference,last_reviewed_at,$6::timestamptz,data_classification
         FROM bop_publishing.live_gate_version WHERE brand_id=$1 AND store_id=$2 AND gate_reference=$3 AND gate_version=$4
           AND NOT EXISTS (SELECT 1 FROM bop_publishing.live_gate_version n WHERE n.brand_id=$1 AND n.store_id=$2
             AND n.gate_reference=$3 AND n.gate_version=$5)
         RETURNING gate_version::int v`,
        [
          input.brandReference,
          input.storeReference,
          head.gate_reference,
          fromVersion,
          toVersion,
          input.at,
        ],
      )
    ).rows;
    if (inserted.length !== 1) fail("INTERNAL_TEST_LIVE_GATE_CONFLICT");
    for (const row of requirements) {
      const next = row.status === "Accepted" && iso(row.valid_until) === input.from;
      await tx.query(
        `INSERT INTO bop_publishing.live_gate_requirement (requirement_id,brand_id,store_id,gate_reference,gate_version,category_code,
           requirement_code,owner_reference,applicable,status,evidence_reference,evidence_version,valid_until,blocking_reason_code,data_classification)
         SELECT $5,brand_id,store_id,gate_reference,$6::bigint,category_code,requirement_code,owner_reference,applicable,status,
           evidence_reference,evidence_version,CASE WHEN $7::boolean THEN $8::timestamptz ELSE valid_until END,blocking_reason_code,data_classification
         FROM bop_publishing.live_gate_requirement WHERE brand_id=$1 AND store_id=$2 AND requirement_id=$3 AND gate_version=$4`,
        [
          input.brandReference,
          input.storeReference,
          row.id,
          fromVersion,
          input.nextReference(),
          toVersion,
          next,
          input.to,
        ],
      );
    }
    for (const row of moved)
      await appendAudit(tx, {
        auditId: input.nextReference(),
        brandId: input.brandReference,
        storeId: input.storeReference,
        actor: { type: "System" },
        actionCode: "INTERNAL_TEST_VALIDITY_EXTENDED",
        targetType: "LiveGateRequirement",
        targetId: String(row.id),
        beforeSummary: {
          gateReference: String(head.gate_reference),
          gateVersion: fromVersion,
          requirementCode: String(row.requirement_code),
          validUntil: input.from,
        },
        afterSummary: {
          gateReference: String(head.gate_reference),
          gateVersion: toVersion,
          requirementCode: String(row.requirement_code),
          validUntil: input.to,
          environment: "InternalTest",
          approvedBy: input.evidence.approvedBy,
          approval: input.evidence.approval,
          reason: input.evidence.reason,
          operatorAccount: input.evidence.operatorAccount,
        },
        reasonCode: "INTERNAL_TEST_RENEWAL",
        correlationId: input.evidence.renewalReference,
        occurredAt: input.at,
        sourceChannel: "DEPLOYMENT",
        dataClassification: "Internal",
        retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
        retentionPolicyVersion: 1,
      });
    renewed.push({
      gateReference: String(head.gate_reference),
      gateId: String(head.gate_id),
      decisionEvidenceReference: String(head.decision_evidence_reference),
      fromVersion,
      toVersion,
      requirements: moved.map((row) => ({
        requirementCode: String(row.requirement_code),
        from: input.from,
        to: input.to,
      })),
    });
  }
  return { renewed, alreadyRenewed, gates };
}
