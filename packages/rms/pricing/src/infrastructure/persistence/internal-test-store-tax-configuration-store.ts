import {
  InternalTestTaxEvidenceRenewalError,
  internalTestTaxFixtureSuiteDigest,
  type InternalTestTaxTransaction,
} from "./internal-test-tax-evidence-renewal-store.js";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (coordinator 2026-10-31) — InternalTest only: the
 * Pricing owner's creation of a TEST Store's own synthetic tax configuration, a copy of the
 * installation Store's synthetic DEMO configuration (both Stores are in the same province in this
 * test). The source must be that synthetic configuration (as its renewal requires: `DEMO_…`, no
 * authoring or publication-candidate provenance, the InternalTest fixture suite and only
 * `SYNTHETIC_…` components). The new configuration takes the source's jurisdiction, currency and
 * every rule (tax class, order type, charge, treatment, rate, inclusion, rounding, order), with
 * the identities, digest, effective period and evidence the InternalTest synthetic tax authority
 * (the internal pricing policy) defines for the target Store; the evidence ends when the source's
 * does, so the installation's renewal window covers both. The root insert's own trigger writes the
 * Brand tax reference projection. Audited under the approver with the approval wording.
 *
 * A rerun finds the same configuration and writes nothing; any other tax configuration at the
 * target Store is refused. A real Store's tax configuration is published through the tax
 * publication flow with the Owner's registration and professional review evidence.
 */
type Fail = InternalTestTaxEvidenceRenewalError["code"];
const fail = (code: Fail): never => {
  throw new InternalTestTaxEvidenceRenewalError(code);
};
const SYNTHETIC = /^[0-9a-f]{8}-0000-7000-8000-[0-9a-f]{12}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SYNTHETIC_CODE = /^SYNTHETIC_[A-Z0-9_]+$/u;
const instant = (value: unknown) =>
  typeof value === "string" && INSTANT.test(value) && new Date(value).toISOString() === value;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);

export interface InternalTestStoreTaxRule {
  readonly ruleReference: string;
  readonly taxClassificationReference: string;
  readonly orderType: string;
  readonly chargeType: string;
  readonly taxComponentCode: string;
  readonly treatment: string;
  readonly rate: string;
  readonly priceInclusion: string;
  readonly roundingMode: string;
  readonly calculationOrder: number;
  readonly compoundOnPriorTax: boolean;
  readonly exceptionEvidenceReference: string | null;
  readonly receiptPresentationCode: string;
}
/** The target configuration as the synthetic tax authority defines it (version 1). */
export interface InternalTestStoreTaxSnapshot {
  readonly configurationReference: string;
  readonly versionReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly stableCode: string;
  readonly versionNumber: number;
  readonly snapshotDigest: string;
  readonly jurisdictionCode: string;
  readonly currencyMetadata: {
    readonly currencyCode: string;
    readonly metadataVersion: number;
    readonly metadataVersionReference: string;
    readonly metadataDigest: string;
  };
  readonly effectivePeriod: {
    readonly timeZone: string;
    readonly effectiveFrom: { readonly instant: string };
    readonly effectiveUntil: { readonly instant: string } | null;
  };
  readonly registrationEvidence: {
    readonly applicabilityReference: string;
    readonly operatingEntityTaxReference: string;
    readonly jurisdictionProfileReference: string;
    readonly validUntil: string;
  };
  readonly professionalEvidence: {
    readonly evidenceReference: string;
    readonly professionalReviewReference: string;
    readonly fixtureSuiteReference: string;
    readonly fixtureSuiteDigest: string;
    readonly validUntil: string;
  };
  readonly rules: readonly InternalTestStoreTaxRule[];
  readonly createdAt: string;
}
export interface InternalTestStoreTaxInput {
  readonly brandReference: string;
  readonly sourceStoreReference: string;
  readonly sourceConfigurationReference: string;
  readonly target: InternalTestStoreTaxSnapshot;
  readonly approverActorReference: string;
  readonly evidence: {
    readonly operationReference: string;
    readonly approvedBy: string;
    readonly approval: string;
    readonly reason: string;
  };
  readonly nextReference: () => string;
}
export type InternalTestStoreTaxResult = Readonly<{
  status: "Created" | "AlreadyPresent";
  configurationReference: string;
  versionReference: string;
  versionNumber: number;
  /** Version 1's creation instant: the synthetic authority derives the target from it. */
  createdAt: string;
}>;

/** What a rule means, without its identity: equal for the source and the target. */
const meaning = (rule: Record<string, unknown>) =>
  JSON.stringify([
    String(rule.taxClassificationReference),
    String(rule.orderType),
    String(rule.chargeType),
    String(rule.taxComponentCode),
    String(rule.treatment),
    String(rule.rate),
    String(rule.priceInclusion),
    String(rule.roundingMode),
    Number(rule.calculationOrder),
    Boolean(rule.compoundOnPriorTax),
    rule.exceptionEvidenceReference === null ? null : String(rule.exceptionEvidenceReference),
    String(rule.receiptPresentationCode),
  ]);
const ruleRead = `SELECT tax_configuration_rule_id::text "ruleReference",tax_classification_id::text "taxClassificationReference",
  order_type "orderType",charge_type "chargeType",tax_component_code "taxComponentCode",treatment,trim_scale(tax_rate)::text rate,
  price_inclusion "priceInclusion",rounding_mode "roundingMode",calculation_order "calculationOrder",
  compound_on_prior_tax "compoundOnPriorTax",exception_evidence_id::text "exceptionEvidenceReference",
  receipt_presentation_code "receiptPresentationCode"
  FROM rms_pricing.tax_configuration_rule WHERE brand_id=$1 AND store_id=$2 AND tax_configuration_version_id=$3
  ORDER BY tax_configuration_rule_id`;

/** Creates the TEST Store's synthetic tax configuration, or answers the one it has. */
export async function createInternalTestStoreTaxConfiguration(
  tx: InternalTestTaxTransaction,
  input: InternalTestStoreTaxInput,
  appendAudit: (
    tx: InternalTestTaxTransaction,
    record: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<InternalTestStoreTaxResult> {
  const t = input.target;
  const at = t?.createdAt;
  if (
    ![
      input.brandReference,
      input.sourceStoreReference,
      t?.storeReference,
      input.approverActorReference,
      input.evidence?.operationReference,
    ].every((value) => typeof value === "string" && UUID_V7.test(value)) ||
    t.brandReference !== input.brandReference ||
    t.storeReference === input.sourceStoreReference ||
    ![
      input.sourceConfigurationReference,
      t.configurationReference,
      t.versionReference,
      t.registrationEvidence?.applicabilityReference,
      t.registrationEvidence?.operatingEntityTaxReference,
      t.registrationEvidence?.jurisdictionProfileReference,
      t.professionalEvidence?.evidenceReference,
      t.professionalEvidence?.professionalReviewReference,
      t.professionalEvidence?.fixtureSuiteReference,
    ].every((value) => typeof value === "string" && SYNTHETIC.test(value)) ||
    t.configurationReference === input.sourceConfigurationReference ||
    !t.stableCode?.startsWith("DEMO_") ||
    t.versionNumber !== 1 ||
    !DIGEST.test(t.snapshotDigest ?? "") ||
    t.professionalEvidence.fixtureSuiteDigest !== internalTestTaxFixtureSuiteDigest ||
    !instant(at) ||
    !instant(t.registrationEvidence.validUntil) ||
    t.professionalEvidence.validUntil !== t.registrationEvidence.validUntil ||
    t.registrationEvidence.validUntil <= at ||
    !instant(t.effectivePeriod?.effectiveFrom?.instant) ||
    !Array.isArray(t.rules) ||
    t.rules.length < 1 ||
    t.rules.length > 64 ||
    t.rules.some(
      (rule) =>
        !SYNTHETIC.test(rule?.ruleReference ?? "") ||
        !SYNTHETIC_CODE.test(rule.taxComponentCode) ||
        !SYNTHETIC_CODE.test(rule.receiptPresentationCode),
    ) ||
    new Set(t.rules.map((rule) => rule.ruleReference)).size !== t.rules.length ||
    typeof input.nextReference !== "function" ||
    typeof input.evidence.approval !== "string" ||
    input.evidence.approval.trim() === "" ||
    typeof input.evidence.approvedBy !== "string" ||
    input.evidence.approvedBy.trim() === ""
  )
    return fail("INTERNAL_TEST_TAX_INPUT_INVALID");
  const scope = (store: string) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      input.brandReference,
      store,
    ]);

  // The source: the installation Store's synthetic configuration, as its current version says.
  await scope(input.sourceStoreReference);
  const source = (
    await tx.query(
      `SELECT b.stable_code,b.aggregate_version::int aggregate_version,v.tax_configuration_version_id::text id,
         v.version_number::int version_number,v.lifecycle,v.fixture_suite_digest,v.authoring_operation_id,
         v.publication_candidate_version_id,v.jurisdiction_code,v.currency_code,v.currency_metadata_version::int currency_metadata_version,
         v.currency_metadata_version_id::text currency_metadata_version_id,v.currency_metadata_digest,
         v.registration_evidence_valid_until reg,v.professional_evidence_valid_until pro
       FROM rms_pricing.tax_configuration b JOIN rms_pricing.tax_configuration_version v
         ON v.tax_configuration_version_id=b.current_version_id AND v.tax_configuration_id=b.tax_configuration_id
         AND v.brand_id=b.brand_id AND v.store_id=b.store_id
       WHERE b.brand_id=$1 AND b.store_id=$2 AND b.tax_configuration_id=$3`,
      [input.brandReference, input.sourceStoreReference, input.sourceConfigurationReference],
    )
  ).rows[0];
  const sourceRules =
    source === undefined
      ? []
      : (
          await tx.query(ruleRead, [
            input.brandReference,
            input.sourceStoreReference,
            String(source.id),
          ])
        ).rows;
  if (
    source === undefined ||
    typeof source.stable_code !== "string" ||
    !source.stable_code.startsWith("DEMO_") ||
    !SYNTHETIC.test(String(source.id)) ||
    source.lifecycle !== "Published" ||
    source.authoring_operation_id !== null ||
    source.publication_candidate_version_id !== null ||
    source.fixture_suite_digest !== internalTestTaxFixtureSuiteDigest ||
    source.aggregate_version !== source.version_number ||
    sourceRules.length < 1 ||
    sourceRules.some(
      (rule) =>
        !SYNTHETIC_CODE.test(String(rule.taxComponentCode)) ||
        !SYNTHETIC_CODE.test(String(rule.receiptPresentationCode)),
    )
  )
    return fail("INTERNAL_TEST_TAX_NOT_SYNTHETIC");
  // The same province, currency, rules and rates as the source; its evidence window.
  const sourceUntil = iso(source.reg);
  if (
    source.jurisdiction_code !== t.jurisdictionCode ||
    source.currency_code !== t.currencyMetadata.currencyCode ||
    source.currency_metadata_version !== t.currencyMetadata.metadataVersion ||
    source.currency_metadata_version_id !== t.currencyMetadata.metadataVersionReference ||
    source.currency_metadata_digest !== t.currencyMetadata.metadataDigest ||
    [...sourceRules.map(meaning)].sort().join("\n") !==
      [...t.rules.map((rule) => meaning(rule as unknown as Record<string, unknown>))]
        .sort()
        .join("\n")
  )
    return fail("INTERNAL_TEST_TAX_SOURCE_MISMATCH");
  if (
    sourceUntil === null ||
    iso(source.pro) !== sourceUntil ||
    t.registrationEvidence.validUntil !== sourceUntil
  )
    return fail("INTERNAL_TEST_TAX_WINDOW_MISMATCH");

  // The target: this configuration again (a rerun), or none at all.
  await scope(t.storeReference);
  const present = (
    await tx.query(
      `SELECT b.tax_configuration_id::text id,b.stable_code,
         (SELECT jsonb_build_object('id',v.tax_configuration_version_id::text,'number',v.version_number,
            'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
          FROM rms_pricing.tax_configuration_version v WHERE v.tax_configuration_id=b.tax_configuration_id
           AND v.brand_id=b.brand_id AND v.store_id=b.store_id AND v.version_number=1) first,
         (SELECT jsonb_build_object('id',v.tax_configuration_version_id::text,'number',v.version_number)
          FROM rms_pricing.tax_configuration_version v WHERE v.tax_configuration_version_id=b.current_version_id
           AND v.brand_id=b.brand_id AND v.store_id=b.store_id) head
       FROM rms_pricing.tax_configuration b WHERE b.brand_id=$1 AND b.store_id=$2 ORDER BY 1`,
      [input.brandReference, t.storeReference],
    )
  ).rows;
  if (present.length > 0) {
    const [row] = present;
    const first = row?.first as { id: string; createdAt: string } | null;
    const head = row?.head as { id: string; number: number } | null;
    if (
      present.length !== 1 ||
      row?.id !== t.configurationReference ||
      first === null ||
      first.id !== t.versionReference ||
      head === null
    )
      return fail("INTERNAL_TEST_TAX_OTHER_CONFIGURATION");
    return Object.freeze({
      status: "AlreadyPresent",
      configurationReference: t.configurationReference,
      versionReference: head.id,
      versionNumber: Number(head.number),
      createdAt: first.createdAt,
    });
  }

  const actor = input.approverActorReference;
  await tx.query(
    `INSERT INTO rms_pricing.tax_configuration (tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at)
     VALUES ($1,$2,$3,$4,1,$5,$6,$5)`,
    [t.configurationReference, t.brandReference, t.storeReference, t.stableCode, at, actor],
  );
  const c = t.currencyMetadata,
    r = t.registrationEvidence,
    p = t.professionalEvidence;
  await tx.query(
    `INSERT INTO rms_pricing.tax_configuration_version (tax_configuration_version_id,tax_configuration_id,brand_id,store_id,
       version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,
       currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,
       operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,
       professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
     VALUES ($1,$2,$3,$4,1,$5,'Published',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$17,$22)`,
    [
      t.versionReference,
      t.configurationReference,
      t.brandReference,
      t.storeReference,
      t.snapshotDigest,
      t.jurisdictionCode,
      c.currencyCode,
      c.metadataVersion,
      c.metadataVersionReference,
      c.metadataDigest,
      t.effectivePeriod.effectiveFrom.instant,
      t.effectivePeriod.effectiveUntil?.instant ?? null,
      t.effectivePeriod.timeZone,
      r.applicabilityReference,
      r.operatingEntityTaxReference,
      r.jurisdictionProfileReference,
      r.validUntil,
      p.evidenceReference,
      p.professionalReviewReference,
      p.fixtureSuiteReference,
      p.fixtureSuiteDigest,
      at,
    ],
  );
  for (const rule of t.rules)
    await tx.query(
      `INSERT INTO rms_pricing.tax_configuration_rule (tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,
         brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,
         rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        rule.ruleReference,
        t.versionReference,
        t.configurationReference,
        t.brandReference,
        t.storeReference,
        rule.taxClassificationReference,
        rule.orderType,
        rule.chargeType,
        rule.taxComponentCode,
        rule.treatment,
        rule.rate,
        rule.priceInclusion,
        rule.roundingMode,
        rule.calculationOrder,
        rule.compoundOnPriorTax,
        rule.exceptionEvidenceReference,
        rule.receiptPresentationCode,
      ],
    );
  const head = (
    await tx.query(
      `UPDATE rms_pricing.tax_configuration SET current_version_id=$4
       WHERE brand_id=$1 AND store_id=$2 AND tax_configuration_id=$3 AND current_version_id IS NULL RETURNING 1`,
      [t.brandReference, t.storeReference, t.configurationReference, t.versionReference],
    )
  ).rows;
  if (head.length !== 1) return fail("INTERNAL_TEST_TAX_CONFLICT");
  await appendAudit(tx, {
    auditId: input.nextReference(),
    brandId: t.brandReference,
    storeId: t.storeReference,
    actor: { type: "User", reference: actor },
    actionCode: "INTERNAL_TEST_STORE_TAX_CREATED",
    targetType: "TaxConfiguration",
    targetId: t.configurationReference,
    afterSummary: {
      configurationReference: t.configurationReference,
      versionReference: t.versionReference,
      versionNumber: 1,
      snapshotDigest: t.snapshotDigest,
      copiedFromConfigurationReference: input.sourceConfigurationReference,
      jurisdictionCode: t.jurisdictionCode,
      rules: t.rules.length,
      registrationEvidenceValidUntil: r.validUntil,
      professionalEvidenceValidUntil: p.validUntil,
      synthetic: true,
      environment: "InternalTest",
      approvedBy: input.evidence.approvedBy,
      approval: input.evidence.approval,
      reason: input.evidence.reason,
    },
    reasonCode: "INTERNAL_TEST_STORE_TAX",
    correlationId: input.evidence.operationReference,
    occurredAt: at,
    sourceChannel: "DEPLOYMENT",
    dataClassification: "Internal",
    retentionPolicyCode: "CONFIGURATION_AUDIT",
    retentionPolicyVersion: 1,
  });
  return Object.freeze({
    status: "Created",
    configurationReference: t.configurationReference,
    versionReference: t.versionReference,
    versionNumber: 1,
    createdAt: at,
  });
}
