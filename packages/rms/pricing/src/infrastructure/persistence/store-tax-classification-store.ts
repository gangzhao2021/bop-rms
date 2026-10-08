import { parsePricingReference } from "../../domain/money-tax-contract.js";

/**
 * WP-2423 / DEC-CAT-PRODUCT-ADMIN: the tax classifications the selected Store's current Published tax
 * configuration covers for sellable items, with each order type's treatment and rate. A Product may
 * only carry a classification the Store can tax; the quote applies the matching rule. Caller
 * authorizes and owns the transaction; the Store scope is set for the read and the Brand scope
 * (empty Store) is restored afterwards.
 */
export interface StoreTaxClassificationChoice {
  readonly taxClassificationReference: string;
  readonly rules: readonly {
    readonly orderType: string;
    readonly taxComponentCode: string;
    readonly treatment: string;
    readonly rate: string;
    readonly priceInclusion: string;
  }[];
}
export async function listStoreTaxClassifications(
  tx: {
    query(
      sql: string,
      values: readonly unknown[],
    ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  },
  scope: { readonly brandReference: string; readonly storeReference: string },
  observedAt: string,
): Promise<readonly StoreTaxClassificationChoice[]> {
  const brand = parsePricingReference(scope.brandReference);
  const store = parsePricingReference(scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  try {
    const rows = (
      await tx.query(
        `SELECT r.tax_classification_id::text classification,r.order_type,r.tax_component_code,r.treatment,
          trim_scale(r.tax_rate)::text rate,r.price_inclusion
         FROM rms_pricing.tax_configuration b
         JOIN rms_pricing.tax_configuration_version v ON v.tax_configuration_version_id=b.current_version_id
          AND v.tax_configuration_id=b.tax_configuration_id AND v.brand_id=b.brand_id AND v.store_id=b.store_id
         JOIN rms_pricing.tax_configuration_rule r ON r.tax_configuration_version_id=v.tax_configuration_version_id
          AND r.tax_configuration_id=b.tax_configuration_id AND r.brand_id=b.brand_id AND r.store_id=b.store_id
         WHERE b.brand_id=$1 AND b.store_id=$2 AND v.lifecycle='Published' AND r.charge_type='Sellable'
          AND v.effective_from<=$3::timestamptz AND (v.effective_until IS NULL OR v.effective_until>$3::timestamptz)
         ORDER BY r.tax_classification_id,r.order_type,r.calculation_order,r.tax_component_code`,
        [brand, store, observedAt],
      )
    ).rows;
    const byClassification = new Map<string, StoreTaxClassificationChoice["rules"][number][]>();
    for (const row of rows) {
      const key = String(row.classification);
      const rules = byClassification.get(key) ?? [];
      rules.push(
        Object.freeze({
          orderType: String(row.order_type),
          taxComponentCode: String(row.tax_component_code),
          treatment: String(row.treatment),
          rate: String(row.rate),
          priceInclusion: String(row.price_inclusion),
        }),
      );
      byClassification.set(key, rules);
    }
    return Object.freeze(
      [...byClassification].map(([taxClassificationReference, rules]) =>
        Object.freeze({ taxClassificationReference, rules: Object.freeze(rules) }),
      ),
    );
  } finally {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
  }
}

/**
 * WP-2423 8.7: the selected Store's current Published tax configuration — what it is and how long
 * it holds (its own end and its registration and professional evidence validity) — or null when the
 * Store has none in effect. Caller authorizes and owns the transaction; Brand scope is restored.
 */
export interface StoreTaxConfigurationSummary {
  readonly stableCode: string;
  readonly versionNumber: number;
  readonly jurisdictionCode: string;
  readonly currencyCode: string;
  readonly timeZone: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly registrationEvidenceValidUntil: string;
  readonly professionalEvidenceValidUntil: string;
  /** Tax component codes in use (e.g. SYNTHETIC_TAX marks internal test rates). */
  readonly componentCodes: readonly string[];
}
export async function loadStoreTaxConfigurationSummary(
  tx: {
    query(
      sql: string,
      values: readonly unknown[],
    ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  },
  scope: { readonly brandReference: string; readonly storeReference: string },
  observedAt: string,
): Promise<StoreTaxConfigurationSummary | null> {
  const brand = parsePricingReference(scope.brandReference);
  const store = parsePricingReference(scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const iso = (value: unknown) =>
    value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  try {
    const rows = (
      await tx.query(
        `SELECT b.stable_code,v.version_number,v.jurisdiction_code,v.currency_code,v.effective_time_zone,
           v.effective_from,v.effective_until,v.registration_evidence_valid_until,v.professional_evidence_valid_until,
           COALESCE((SELECT array_agg(DISTINCT r.tax_component_code ORDER BY r.tax_component_code)
             FROM rms_pricing.tax_configuration_rule r WHERE r.tax_configuration_version_id=v.tax_configuration_version_id
             AND r.brand_id=v.brand_id AND r.store_id=v.store_id),'{}') components
         FROM rms_pricing.tax_configuration b
         JOIN rms_pricing.tax_configuration_version v ON v.tax_configuration_version_id=b.current_version_id
          AND v.tax_configuration_id=b.tax_configuration_id AND v.brand_id=b.brand_id AND v.store_id=b.store_id
         WHERE b.brand_id=$1 AND b.store_id=$2 AND v.lifecycle='Published'
          AND v.effective_from<=$3::timestamptz AND (v.effective_until IS NULL OR v.effective_until>$3::timestamptz)
         ORDER BY b.stable_code LIMIT 2`,
        [brand, store, observedAt],
      )
    ).rows;
    // One configuration governs a Store; more than one in effect is not a usable state.
    if (rows.length !== 1) return null;
    const row = rows[0] as Record<string, unknown>;
    return Object.freeze({
      stableCode: String(row.stable_code),
      versionNumber: Number(row.version_number),
      jurisdictionCode: String(row.jurisdiction_code),
      currencyCode: String(row.currency_code),
      timeZone: String(row.effective_time_zone),
      effectiveFrom: iso(row.effective_from),
      effectiveUntil: row.effective_until === null ? null : iso(row.effective_until),
      registrationEvidenceValidUntil: iso(row.registration_evidence_valid_until),
      professionalEvidenceValidUntil: iso(row.professional_evidence_valid_until),
      componentCodes: Object.freeze((row.components as string[]).map(String)),
    });
  } finally {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
  }
}
