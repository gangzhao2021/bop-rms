import assert from "node:assert/strict";
import { createOptionPriceRuleSnapshot } from "../../rms/pricing/src/index.ts";
/** Isolated synthetic policy fixture; not a publishing command or Store approval. */
export async function seedOptionPriceRule(admin, value, actorReference, number = 1) {
  const rule = createOptionPriceRuleSnapshot(value);
  if (number === 1)
    await admin.query(
      "INSERT INTO rms_pricing.option_price_rule(option_price_rule_id,brand_id,binding_id,option_id,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,1,$5,$6,$5)",
      [
        rule.ruleReference,
        rule.brandReference,
        rule.bindingReference,
        rule.optionReference,
        rule.createdAt,
        actorReference,
      ],
    );
  await admin.query(
    "INSERT INTO rms_pricing.option_price_rule_version(option_price_rule_version_id,option_price_rule_id,brand_id,binding_id,option_id,version_number,snapshot_digest,lifecycle,sku_id,scope_kind,scope_id,channel_code,order_type,currency_code,currency_minor_unit_exponent,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,unit_amount_minor,included_quantity,quantity_basis,effective_from,effective_until,effective_time_zone,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)",
    [
      rule.versionReference,
      rule.ruleReference,
      rule.brandReference,
      rule.bindingReference,
      rule.optionReference,
      number,
      rule.snapshotDigest,
      rule.lifecycle,
      rule.skuReference,
      rule.scopeKind,
      rule.scopeReference,
      rule.channelCode,
      rule.orderType,
      rule.currencyMetadata.currencyCode,
      rule.currencyMetadata.minorUnitExponent,
      rule.currencyMetadata.metadataVersion,
      rule.currencyMetadata.metadataVersionReference,
      rule.currencyMetadata.metadataDigest,
      rule.unitAmount.amountMinor.toString(),
      rule.includedQuantity,
      rule.quantityBasis,
      rule.effectivePeriod.effectiveFrom.instant,
      rule.effectivePeriod.effectiveUntil?.instant ?? null,
      rule.effectivePeriod.timeZone,
      rule.createdAt,
    ],
  );
  const result = await admin.query(
    "UPDATE rms_pricing.option_price_rule SET current_version_id=$1,aggregate_version=$2,updated_at=$3 WHERE option_price_rule_id=$4 AND brand_id=$5 AND aggregate_version=$6",
    [
      rule.versionReference,
      number,
      rule.createdAt,
      rule.ruleReference,
      rule.brandReference,
      Math.max(1, number - 1),
    ],
  );
  assert.equal(result.rowCount, 1);
  return rule;
}
