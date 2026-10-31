/**
 * WP-2423 InternalTest only: the Pricing owner's Owner-approved renewal of the synthetic DEMO tax
 * configuration's evidence validity. Tax versions are append-only, so the renewal appends the
 * next Published version: every fact of the current version (jurisdiction, currency, effective
 * period, evidence references, rules and their rates) is copied unchanged; only the registration
 * and professional evidence `valid_until` move from the installation's common expiry to the
 * approved new end (at most 30 days ahead), and the version gets its own identity, number,
 * creation instant and snapshot digest. The digest and identities come from the InternalTest
 * synthetic tax authority (the internal pricing policy), so the current read accepts the new
 * version only with matching evidence. The configuration head moves to it and the change is
 * audited (before → after, approval).
 *
 * Refused unless the configuration is the synthetic DEMO one: stable code `DEMO_…`, a legacy
 * synthetic version (no authoring or publication-candidate provenance), the InternalTest fixture
 * suite digest and only `SYNTHETIC_…` tax components and receipt lines. A real Store's tax
 * evidence is renewed by publishing a new version through the tax publication flow.
 */
export interface InternalTestTaxTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export class InternalTestTaxEvidenceRenewalError extends Error {
  constructor(
    readonly code:
      | "INTERNAL_TEST_TAX_INPUT_INVALID"
      | "INTERNAL_TEST_TAX_NOT_SYNTHETIC"
      | "INTERNAL_TEST_TAX_WINDOW_MISMATCH"
      | "INTERNAL_TEST_TAX_CONFLICT"
      | "INTERNAL_TEST_TAX_SOURCE_MISMATCH"
      | "INTERNAL_TEST_TAX_OTHER_CONFIGURATION",
  ) {
    super(code);
    this.name = "InternalTestTaxEvidenceRenewalError";
  }
}
const fail = (code: InternalTestTaxEvidenceRenewalError["code"]): never => {
  throw new InternalTestTaxEvidenceRenewalError(code);
};
/** sha256 of the JSON text `"INTERNAL_TEST_ONLY"`: the InternalTest fixture suite marker. */
export const internalTestTaxFixtureSuiteDigest =
  "sha256:b34dbe3aa9e5efdf5b455a07d36eb95ccfd24c6622f772d7b04624b0591a38ca";
const SYNTHETIC = /^[0-9a-f]{8}-0000-7000-8000-[0-9a-f]{12}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SYNTHETIC_CODE = /^SYNTHETIC_[A-Z0-9_]+$/u;
const MAX_DAYS = 30;
const instant = (value: unknown) =>
  typeof value === "string" && INSTANT.test(value) && new Date(value).toISOString() === value;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);

export interface InternalTestTaxEvidenceRenewalInput {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly configurationReference: string;
  readonly from: string;
  readonly to: string;
  readonly at: string;
  /** The next version as the synthetic tax authority defines it. */
  readonly next: {
    readonly versionReference: string;
    readonly versionNumber: number;
    readonly snapshotDigest: string;
    /** New rule identity for each current rule, in the authority's rule order. */
    readonly rules: readonly { readonly from: string; readonly to: string }[];
  };
  readonly evidence: {
    readonly renewalReference: string;
    readonly approvedBy: string;
    readonly approval: string;
    readonly reason: string;
    readonly operatorAccount: string;
  };
  readonly nextReference: () => string;
}
export type InternalTestTaxEvidenceRenewal =
  | {
      readonly status: "Renewed";
      readonly fromVersion: { readonly reference: string; readonly number: number };
      readonly toVersion: { readonly reference: string; readonly number: number };
      readonly createdAt: string;
      readonly from: string;
      readonly to: string;
      readonly referenceScopeRestored: boolean;
    }
  | {
      readonly status: "AlreadyRenewed";
      readonly version: { readonly reference: string; readonly number: number };
      readonly createdAt: string;
    };

const copiedColumns =
  "tax_configuration_id,brand_id,store_id,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest";
const ruleColumns =
  "tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code";

/** Renews the synthetic DEMO tax evidence of one Store; see the module note. */
export async function renewInternalTestTaxEvidence(
  tx: InternalTestTaxTransaction,
  input: InternalTestTaxEvidenceRenewalInput,
  /** The platform Audit append (`appendAuditRecordInTransaction`) supplied by the composition. */
  appendAudit: (
    tx: InternalTestTaxTransaction,
    record: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<InternalTestTaxEvidenceRenewal> {
  const next = input.next;
  if (
    ![input.brandReference, input.configurationReference].every((value) => SYNTHETIC.test(value)) ||
    // A TEST Store opened in the product has its own (not synthetic) reference; its configuration
    // stays synthetic (internal-test-store-tax-configuration-store).
    !UUID_V7.test(input.storeReference) ||
    !instant(input.from) ||
    !instant(input.to) ||
    !instant(input.at) ||
    input.to < input.from ||
    input.to <= input.at ||
    Date.parse(input.to) > Date.parse(input.at) + MAX_DAYS * 86_400_000 ||
    !UUID_V7.test(input.evidence.renewalReference) ||
    typeof input.nextReference !== "function" ||
    !SYNTHETIC.test(next?.versionReference ?? "") ||
    !Number.isSafeInteger(next.versionNumber) ||
    next.versionNumber < 2 ||
    !DIGEST.test(next.snapshotDigest ?? "") ||
    !Array.isArray(next.rules) ||
    next.rules.length < 1 ||
    next.rules.length > 64 ||
    next.rules.some((rule) => !SYNTHETIC.test(rule?.from ?? "") || !SYNTHETIC.test(rule?.to ?? ""))
  )
    fail("INTERNAL_TEST_TAX_INPUT_INVALID");
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    input.brandReference,
    input.storeReference,
  ]);
  const root = (
    await tx.query(
      `SELECT stable_code,aggregate_version::int aggregate_version,current_version_id::text current FROM rms_pricing.tax_configuration
       WHERE brand_id=$1 AND store_id=$2 AND tax_configuration_id=$3 FOR UPDATE`,
      [input.brandReference, input.storeReference, input.configurationReference],
    )
  ).rows[0];
  if (root === undefined) return fail("INTERNAL_TEST_TAX_NOT_SYNTHETIC");
  const current = (
    await tx.query(
      `SELECT tax_configuration_version_id::text id,version_number::int version_number,lifecycle,fixture_suite_digest,
         registration_evidence_valid_until reg,professional_evidence_valid_until pro,created_at,
         authoring_operation_id,publication_candidate_version_id
       FROM rms_pricing.tax_configuration_version WHERE brand_id=$1 AND store_id=$2 AND tax_configuration_version_id=$3`,
      [input.brandReference, input.storeReference, root.current],
    )
  ).rows[0];
  const rules = (
    await tx.query(
      `SELECT tax_configuration_rule_id::text id,tax_component_code,receipt_presentation_code FROM rms_pricing.tax_configuration_rule
       WHERE brand_id=$1 AND store_id=$2 AND tax_configuration_version_id=$3 ORDER BY tax_configuration_rule_id`,
      [input.brandReference, input.storeReference, root.current],
    )
  ).rows;
  if (
    current === undefined ||
    typeof root.stable_code !== "string" ||
    !root.stable_code.startsWith("DEMO_") ||
    !SYNTHETIC.test(String(current.id)) ||
    current.lifecycle !== "Published" ||
    current.authoring_operation_id !== null ||
    current.publication_candidate_version_id !== null ||
    current.fixture_suite_digest !== internalTestTaxFixtureSuiteDigest ||
    root.aggregate_version !== current.version_number ||
    rules.length < 1 ||
    rules.some(
      (rule) =>
        !SYNTHETIC.test(String(rule.id)) ||
        !SYNTHETIC_CODE.test(String(rule.tax_component_code)) ||
        !SYNTHETIC_CODE.test(String(rule.receipt_presentation_code)),
    )
  )
    return fail("INTERNAL_TEST_TAX_NOT_SYNTHETIC");
  const reg = iso(current.reg),
    pro = iso(current.pro);
  const createdAt = iso(current.created_at) ?? fail("INTERNAL_TEST_TAX_CONFLICT");
  if (reg === input.to && pro === input.to)
    return {
      status: "AlreadyRenewed",
      version: { reference: String(current.id), number: Number(current.version_number) },
      createdAt,
    };
  if (reg !== input.from || pro !== input.from || input.from === input.to)
    return fail("INTERNAL_TEST_TAX_WINDOW_MISMATCH");
  // The Brand tax reference projection (1200_012) is maintained by the tax triggers; an
  // installation seeded without it (v15) refuses every new version. Restore exactly the rows the
  // root insert trigger would have written for this configuration, then continue.
  await tx.query("SELECT set_config('bop.store_id','',true)", []);
  await tx.query(
    "INSERT INTO rms_pricing.tax_reference_generation VALUES ($1,0,0) ON CONFLICT (brand_id) DO NOTHING",
    [input.brandReference],
  );
  const scoped = (
    await tx.query(
      `INSERT INTO rms_pricing.tax_reference_scope VALUES ($1,$2,$3,true,$4,$5)
       ON CONFLICT (brand_id,store_id,tax_configuration_id) DO NOTHING RETURNING tax_configuration_id`,
      [
        input.brandReference,
        input.storeReference,
        input.configurationReference,
        root.aggregate_version,
        current.id,
      ],
    )
  ).rows;
  if (scoped.length === 1)
    await tx.query(
      "UPDATE rms_pricing.tax_reference_generation SET generation=generation+1,reference_count=reference_count+1 WHERE brand_id=$1",
      [input.brandReference],
    );
  await tx.query("SELECT set_config('bop.store_id',$1,true)", [input.storeReference]);
  const referenceScopeRestored = scoped.length === 1;
  const fromIds = rules.map((rule) => String(rule.id));
  if (
    next.versionNumber !== Number(current.version_number) + 1 ||
    next.rules.length !== rules.length ||
    [...next.rules.map((rule) => rule.from)].sort().join() !== fromIds.join() ||
    new Set(next.rules.map((rule) => rule.to)).size !== next.rules.length
  )
    return fail("INTERNAL_TEST_TAX_INPUT_INVALID");
  await tx.query(
    `INSERT INTO rms_pricing.tax_configuration_version (tax_configuration_version_id,version_number,snapshot_digest,
       registration_evidence_valid_until,professional_evidence_valid_until,created_at,${copiedColumns})
     SELECT $4,$5,$6,$7::timestamptz,$7::timestamptz,$8::timestamptz,${copiedColumns}
     FROM rms_pricing.tax_configuration_version WHERE brand_id=$1 AND store_id=$2 AND tax_configuration_version_id=$3`,
    [
      input.brandReference,
      input.storeReference,
      current.id,
      next.versionReference,
      next.versionNumber,
      next.snapshotDigest,
      input.to,
      input.at,
    ],
  );
  for (const rule of next.rules)
    await tx.query(
      `INSERT INTO rms_pricing.tax_configuration_rule (tax_configuration_rule_id,tax_configuration_version_id,${ruleColumns})
       SELECT $4,$5,${ruleColumns} FROM rms_pricing.tax_configuration_rule
       WHERE brand_id=$1 AND store_id=$2 AND tax_configuration_version_id=$3 AND tax_configuration_rule_id=$6`,
      [
        input.brandReference,
        input.storeReference,
        current.id,
        rule.to,
        next.versionReference,
        rule.from,
      ],
    );
  const moved = (
    await tx.query(
      `UPDATE rms_pricing.tax_configuration SET aggregate_version=aggregate_version+1,current_version_id=$4,updated_at=$5
       WHERE brand_id=$1 AND store_id=$2 AND tax_configuration_id=$3 AND aggregate_version=$6 AND current_version_id=$7
       RETURNING aggregate_version::int v`,
      [
        input.brandReference,
        input.storeReference,
        input.configurationReference,
        next.versionReference,
        input.at,
        root.aggregate_version,
        current.id,
      ],
    )
  ).rows;
  if (moved.length !== 1 || moved[0]?.v !== next.versionNumber)
    return fail("INTERNAL_TEST_TAX_CONFLICT");
  await appendAudit(tx, {
    auditId: input.nextReference(),
    brandId: input.brandReference,
    storeId: input.storeReference,
    actor: { type: "System" },
    actionCode: "INTERNAL_TEST_VALIDITY_EXTENDED",
    targetType: "TaxConfigurationVersion",
    targetId: next.versionReference,
    beforeSummary: {
      configurationReference: input.configurationReference,
      versionReference: String(current.id),
      versionNumber: Number(current.version_number),
      registrationEvidenceValidUntil: input.from,
      professionalEvidenceValidUntil: input.from,
    },
    afterSummary: {
      configurationReference: input.configurationReference,
      versionReference: next.versionReference,
      versionNumber: next.versionNumber,
      snapshotDigest: next.snapshotDigest,
      registrationEvidenceValidUntil: input.to,
      professionalEvidenceValidUntil: input.to,
      referenceScopeRestored,
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
    retentionPolicyCode: "CONFIGURATION_AUDIT",
    retentionPolicyVersion: 1,
  });
  return {
    status: "Renewed",
    fromVersion: { reference: String(current.id), number: Number(current.version_number) },
    toVersion: { reference: next.versionReference, number: next.versionNumber },
    createdAt: input.at,
    from: input.from,
    to: input.to,
    referenceScopeRestored,
  };
}
