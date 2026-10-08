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
