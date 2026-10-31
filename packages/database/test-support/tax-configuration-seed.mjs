/** Synthetic acceptance configuration only; never a source of real Store approval. */
export async function seedTaxConfiguration(admin, snapshot, actorReference) {
  const s = snapshot,
    c = s.currencyMetadata,
    r = s.registrationEvidence,
    p = s.professionalEvidence;
  await admin.query(
    "INSERT INTO rms_pricing.tax_configuration (tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$6)",
    [
      s.configurationReference,
      s.brandReference,
      s.storeReference,
      s.stableCode,
      s.aggregateVersion,
      s.createdAt,
      actorReference,
    ],
  );
  await admin.query(
    "INSERT INTO rms_pricing.tax_configuration_version (tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)",
    [
      s.versionReference,
      s.configurationReference,
      s.brandReference,
      s.storeReference,
      s.versionNumber,
      s.snapshotDigest,
      s.lifecycle,
      s.jurisdictionCode,
      c.currencyCode,
      c.metadataVersion,
      c.metadataVersionReference,
      c.metadataDigest,
      s.effectivePeriod.effectiveFrom.instant,
      s.effectivePeriod.effectiveUntil?.instant ?? null,
      s.effectivePeriod.timeZone,
      r?.applicabilityReference ?? null,
      r?.operatingEntityTaxReference ?? null,
      r?.jurisdictionProfileReference ?? null,
      r?.validUntil ?? null,
      p?.evidenceReference ?? null,
      p?.professionalReviewReference ?? null,
      p?.fixtureSuiteReference ?? null,
      p?.fixtureSuiteDigest ?? null,
      p?.validUntil ?? null,
      s.createdAt,
    ],
  );
  for (const rule of s.rules)
    await admin.query(
      "INSERT INTO rms_pricing.tax_configuration_rule (tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
      [
        rule.ruleReference,
        s.versionReference,
        s.configurationReference,
        s.brandReference,
        s.storeReference,
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
  await admin.query(
    "UPDATE rms_pricing.tax_configuration SET current_version_id=$1 WHERE tax_configuration_id=$2",
    [s.versionReference, s.configurationReference],
  );
}
