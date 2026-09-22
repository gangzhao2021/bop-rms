import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  createCurrencyMetadataSnapshot,
  parsePricingReference,
  type CurrencyMetadataSnapshot,
} from "../../domain/money-tax-contract.js";
import {
  createTaxConfigurationSnapshot,
  type TaxConfigurationSnapshot,
  type TaxRegistrationEvidence,
  type TaxProfessionalEvidence,
} from "../../domain/tax-configuration.js";
import type { PriceQuoteQueryTransactionRunner } from "./price-quote-query-store.js";

export class CurrentTaxConfigurationError extends Error {
  readonly code = "CURRENT_TAX_CONFIGURATION_UNAVAILABLE";
  constructor() {
    super("current tax configuration is unavailable");
    this.name = "CurrentTaxConfigurationError";
  }
}
function fail(): never {
  throw new CurrentTaxConfigurationError();
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail();
    result[field] = descriptor.value;
  }
  return result;
}

const select = `SELECT jsonb_build_object(
'configurationReference',b.tax_configuration_id,'versionReference',v.tax_configuration_version_id,
'brandReference',b.brand_id,'storeReference',b.store_id,'stableCode',b.stable_code,
'aggregateVersion',b.aggregate_version,'versionNumber',v.version_number,'snapshotDigest',v.snapshot_digest,
'lifecycle',v.lifecycle,'jurisdictionCode',v.jurisdiction_code,
'currencyMetadata',jsonb_build_object('currencyCode',v.currency_code,'metadataVersion',v.currency_metadata_version,
'metadataVersionReference',v.currency_metadata_version_id,'metadataDigest',v.currency_metadata_digest),
'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'effectivePeriod',jsonb_build_object('timeZone',v.effective_time_zone,'effectiveFrom',jsonb_build_object('instant',to_char(v.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localDateTime',to_char(v.effective_from AT TIME ZONE v.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((v.effective_from AT TIME ZONE v.effective_time_zone)-(v.effective_from AT TIME ZONE 'UTC')))/60),
'effectiveUntil',CASE WHEN v.effective_until IS NULL THEN NULL ELSE jsonb_build_object('instant',to_char(v.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localDateTime',to_char(v.effective_until AT TIME ZONE v.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((v.effective_until AT TIME ZONE v.effective_time_zone)-(v.effective_until AT TIME ZONE 'UTC')))/60) END),
'registrationEvidence',jsonb_build_object('applicabilityReference',v.registration_applicability_id,
'operatingEntityTaxReference',v.operating_entity_tax_reference_id,'jurisdictionProfileReference',v.jurisdiction_profile_id,
'validUntil',to_char(v.registration_evidence_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
'professionalEvidence',jsonb_build_object('evidenceReference',v.professional_evidence_id,
'professionalReviewReference',v.professional_review_reference_id,'fixtureSuiteReference',v.fixture_suite_reference_id,
'fixtureSuiteDigest',v.fixture_suite_digest,'validUntil',to_char(v.professional_evidence_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
'rules',COALESCE((SELECT jsonb_agg(jsonb_build_object(
'ruleReference',r.tax_configuration_rule_id,'taxClassificationReference',r.tax_classification_id,
'orderType',r.order_type,'chargeType',r.charge_type,'taxComponentCode',r.tax_component_code,
'treatment',r.treatment,'rate',trim_scale(r.tax_rate)::text,'priceInclusion',r.price_inclusion,
'roundingMode',r.rounding_mode,'calculationOrder',r.calculation_order,'compoundOnPriorTax',r.compound_on_prior_tax,
'exceptionEvidenceReference',r.exception_evidence_id,'receiptPresentationCode',r.receipt_presentation_code)
ORDER BY r.tax_configuration_rule_id) FROM rms_pricing.tax_configuration_rule r
WHERE r.brand_id=b.brand_id AND r.store_id=b.store_id AND r.tax_configuration_id=b.tax_configuration_id
AND r.tax_configuration_version_id=v.tax_configuration_version_id),'[]'::jsonb)
) AS snapshot,
NOT EXISTS(SELECT 1 FROM (VALUES (b.updated_at),(v.created_at),(v.effective_from),(v.effective_until),
(v.registration_evidence_valid_until),(v.professional_evidence_valid_until)) AS times(value)
WHERE date_trunc('milliseconds',times.value)<>times.value) AS precise
FROM rms_pricing.tax_configuration b JOIN rms_pricing.tax_configuration_version v
ON v.tax_configuration_version_id=b.current_version_id AND v.tax_configuration_id=b.tax_configuration_id
AND v.brand_id=b.brand_id AND v.store_id=b.store_id
WHERE b.brand_id=$1 AND b.store_id=$2 AND b.tax_configuration_id=$3 AND v.lifecycle='Published'
AND b.created_at<=$4::timestamptz AND b.updated_at<=$4::timestamptz AND v.created_at<=$4::timestamptz`;

export interface CurrentTaxEvidenceSource {
  load(
    input: Readonly<{
      brandReference: string;
      storeReference: string;
      configurationReference: string;
      versionReference: string;
      snapshotDigest: string;
      registrationApplicabilityReference: string;
      professionalEvidenceReference: string;
      observedAt: string;
    }>,
  ): Promise<Readonly<{
    registrationEvidence: TaxRegistrationEvidence;
    professionalEvidence: TaxProfessionalEvidence;
  }> | null>;
}

/** Owner read only. Complete evidence must come from its authority, never Published defaults. */
export function createPostgresCurrentTaxConfigurationStore(
  runner: PriceQuoteQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  currencyInput: CurrencyMetadataSnapshot,
  evidence: CurrentTaxEvidenceSource,
) {
  const rawScope = closed(scope, ["brandReference", "storeReference"]);
  const brand = parsePricingReference(rawScope.brandReference);
  const store = parsePricingReference(rawScope.storeReference);
  const currency = createCurrencyMetadataSnapshot(currencyInput);
  return Object.freeze({
    async load(
      input: Readonly<{ configurationReference: string; observedAt: string }>,
    ): Promise<TaxConfigurationSnapshot | null> {
      try {
        const raw = closed(input, ["configurationReference", "observedAt"]);
        const reference = parsePricingReference(raw.configurationReference);
        const observedAt = parseEffectivePeriodInstant(raw.observedAt);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          const result = await tx.query(select, [brand, store, reference, observedAt]);
          if (result === null || typeof result !== "object") fail();
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(rows) || rows.length > 1) fail();
          if (rows.length === 0) return null;
          const envelope = closed(rows[0], ["snapshot", "precise"]);
          if (envelope.precise !== true) fail();
          const row = closed(envelope.snapshot, [
            "configurationReference",
            "versionReference",
            "brandReference",
            "storeReference",
            "stableCode",
            "aggregateVersion",
            "versionNumber",
            "snapshotDigest",
            "lifecycle",
            "jurisdictionCode",
            "currencyMetadata",
            "effectivePeriod",
            "registrationEvidence",
            "professionalEvidence",
            "rules",
            "createdAt",
          ]);
          const metadata = closed(row.currencyMetadata, [
            "currencyCode",
            "metadataVersion",
            "metadataVersionReference",
            "metadataDigest",
          ]);
          for (const key of [
            "currencyCode",
            "metadataVersion",
            "metadataVersionReference",
            "metadataDigest",
          ] as const)
            if (metadata[key] !== currency[key]) fail();
          if (
            row.brandReference !== brand ||
            row.storeReference !== store ||
            row.configurationReference !== reference
          )
            fail();
          const registration = closed(row.registrationEvidence, [
            "applicabilityReference",
            "operatingEntityTaxReference",
            "jurisdictionProfileReference",
            "validUntil",
          ]);
          const professional = closed(row.professionalEvidence, [
            "evidenceReference",
            "professionalReviewReference",
            "fixtureSuiteReference",
            "fixtureSuiteDigest",
            "validUntil",
          ]);
          const full = await evidence.load({
            brandReference: brand,
            storeReference: store,
            configurationReference: reference,
            versionReference: parsePricingReference(row.versionReference),
            snapshotDigest: row.snapshotDigest as string,
            registrationApplicabilityReference: parsePricingReference(
              registration.applicabilityReference,
            ),
            professionalEvidenceReference: parsePricingReference(professional.evidenceReference),
            observedAt,
          });
          if (full === null) fail();
          const supplied = closed(full, ["registrationEvidence", "professionalEvidence"]);
          const snapshot = createTaxConfigurationSnapshot({
            ...row,
            ...supplied,
            currencyMetadata: currency,
          } as unknown as TaxConfigurationSnapshot);
          if (
            snapshot.lifecycle !== "Published" ||
            snapshot.registrationEvidence === null ||
            snapshot.professionalEvidence === null
          )
            fail();
          const completeRegistration = snapshot.registrationEvidence;
          const completeProfessional = snapshot.professionalEvidence;
          for (const key of [
            "applicabilityReference",
            "operatingEntityTaxReference",
            "jurisdictionProfileReference",
            "validUntil",
          ] as const)
            if (registration[key] !== completeRegistration[key]) fail();
          for (const key of [
            "evidenceReference",
            "professionalReviewReference",
            "fixtureSuiteReference",
            "fixtureSuiteDigest",
            "validUntil",
          ] as const)
            if (professional[key] !== completeProfessional[key]) fail();
          if (
            snapshot.createdAt > observedAt ||
            completeProfessional.reviewedAt > observedAt ||
            completeProfessional.validUntil <= observedAt ||
            completeRegistration.validUntil <= observedAt ||
            snapshot.effectivePeriod.effectiveFrom.instant > observedAt ||
            (snapshot.effectivePeriod.effectiveUntil !== null &&
              snapshot.effectivePeriod.effectiveUntil.instant <= observedAt)
          )
            fail();
          return snapshot;
        });
      } catch {
        return fail();
      }
    },
  });
}
