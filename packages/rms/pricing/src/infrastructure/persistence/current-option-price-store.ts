import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  createCurrencyMetadataSnapshot,
  parsePricingReference,
  parsePricingCode,
  type CurrencyMetadataSnapshot,
} from "../../domain/money-tax-contract.js";
import {
  createOptionPriceRuleSnapshot,
  type OptionPriceRuleSnapshot,
} from "../../domain/option-price.js";
import type { PriceOrderType } from "../../domain/price-resolution.js";
import type { PriceQuoteQueryTransactionRunner } from "./price-quote-query-store.js";

export interface CurrentOptionPriceInput {
  readonly bindingReference: string;
  readonly optionReference: string;
  readonly skuReference: string;
  readonly storeGroupReference: string | null;
  readonly regionReference: string | null;
  readonly channelCode: string;
  readonly orderType: PriceOrderType;
  readonly observedAt: string;
}
export class CurrentOptionPriceError extends Error {
  readonly code = "CURRENT_OPTION_PRICE_UNAVAILABLE";
  constructor() {
    super("current option price is unavailable");
    this.name = "CurrentOptionPriceError";
  }
}
function fail(): never {
  throw new CurrentOptionPriceError();
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[field] = descriptor.value;
  }
  return result;
}
const optional = (value: unknown) => (value === null ? null : parsePricingReference(value));
const positiveVersion = (value: unknown) => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value)) return fail();
  const parsed = BigInt(value);
  if (parsed > 9223372036854775807n) return fail();
  return parsed;
};
const select = `SELECT jsonb_build_object(
 'ruleReference',r.option_price_rule_id,'versionReference',v.option_price_rule_version_id,
 'snapshotDigest',v.snapshot_digest,'brandReference',r.brand_id,'bindingReference',r.binding_id,
 'optionReference',r.option_id,'skuReference',v.sku_id,'scopeKind',v.scope_kind,'scopeReference',v.scope_id,
 'channelCode',v.channel_code,'orderType',v.order_type,'lifecycle',v.lifecycle,
 'currencyMetadata',jsonb_build_object('currencyCode',v.currency_code,
   'minorUnitExponent',v.currency_minor_unit_exponent,'metadataVersion',v.currency_metadata_version,
   'metadataVersionReference',v.currency_metadata_version_id,'metadataDigest',v.currency_metadata_digest),
 'unitAmount',jsonb_build_object('amountMinor',v.unit_amount_minor::text,'currencyCode',v.currency_code),
 'includedQuantity',v.included_quantity,'quantityBasis',v.quantity_basis,
 'effectivePeriod',jsonb_build_object('timeZone',v.effective_time_zone,
   'effectiveFrom',jsonb_build_object('instant',to_char(v.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'localDateTime',to_char(v.effective_from AT TIME ZONE v.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),
     'utcOffsetMinutes',extract(epoch FROM ((v.effective_from AT TIME ZONE v.effective_time_zone)-(v.effective_from AT TIME ZONE 'UTC')))/60),
   'effectiveUntil',CASE WHEN v.effective_until IS NULL THEN NULL ELSE jsonb_build_object(
     'instant',to_char(v.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'localDateTime',to_char(v.effective_until AT TIME ZONE v.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),
     'utcOffsetMinutes',extract(epoch FROM ((v.effective_until AT TIME ZONE v.effective_time_zone)-(v.effective_until AT TIME ZONE 'UTC')))/60) END),
 'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) AS snapshot,
 r.aggregate_version::text AS "aggregateVersion", v.version_number::text AS "versionNumber",
 to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "rootCreatedAt",
 to_char(r.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "rootUpdatedAt",
 (date_trunc('milliseconds',r.created_at)=r.created_at
 AND date_trunc('milliseconds',r.updated_at)=r.updated_at
 AND date_trunc('milliseconds',v.created_at)=v.created_at
 AND date_trunc('milliseconds',v.effective_from)=v.effective_from
 AND (v.effective_until IS NULL OR date_trunc('milliseconds',v.effective_until)=v.effective_until)) AS precise
FROM rms_pricing.option_price_rule r
JOIN rms_pricing.option_price_rule_version v
 ON v.option_price_rule_version_id=r.current_version_id AND v.option_price_rule_id=r.option_price_rule_id
 AND v.brand_id=r.brand_id AND v.binding_id=r.binding_id AND v.option_id=r.option_id
WHERE r.brand_id=$1 AND r.binding_id=$3 AND r.option_id=$4
 AND (v.sku_id IS NULL OR v.sku_id=$5)
 AND (v.scope_kind='Brand' OR (v.scope_kind='Store' AND v.scope_id=$2)
 OR (v.scope_kind='StoreGroup' AND v.scope_id=$6) OR (v.scope_kind='Region' AND v.scope_id=$7))
 AND (v.channel_code IS NULL OR v.channel_code=$8)
 AND (v.order_type IS NULL OR v.order_type=$9)
ORDER BY r.option_price_rule_id LIMIT 1001`;

/** Pricing owner read with server-resolved applicability; not authorization or publication validation. */
export function createPostgresCurrentOptionPriceStore(
  runner: PriceQuoteQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  currencyInput: CurrencyMetadataSnapshot,
) {
  const rawScope = closed(scope, ["brandReference", "storeReference"]);
  const brand = parsePricingReference(rawScope.brandReference),
    store = parsePricingReference(rawScope.storeReference);
  const currency = createCurrencyMetadataSnapshot(currencyInput);
  return Object.freeze({
    async load(input: CurrentOptionPriceInput): Promise<readonly OptionPriceRuleSnapshot[]> {
      try {
        const raw = closed(input, [
          "bindingReference",
          "optionReference",
          "skuReference",
          "storeGroupReference",
          "regionReference",
          "channelCode",
          "orderType",
          "observedAt",
        ]);
        const binding = parsePricingReference(raw.bindingReference),
          choice = parsePricingReference(raw.optionReference),
          sku = parsePricingReference(raw.skuReference),
          group = optional(raw.storeGroupReference),
          region = optional(raw.regionReference),
          channel = parsePricingCode(raw.channelCode),
          observedAt = parseEffectivePeriodInstant(raw.observedAt);
        if (raw.orderType !== "DineIn" && raw.orderType !== "Pickup") return fail();
        const orderType = raw.orderType;
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          const result = await tx.query(select, [
            brand,
            store,
            binding,
            choice,
            sku,
            group,
            region,
            channel,
            orderType,
          ]);
          if (result === null || typeof result !== "object") return fail();
          const values = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(values) || values.length > 1000) return fail();
          const ids = new Set<string>();
          const snapshots = values.map((value: unknown) => {
            const row = closed(value, [
              "snapshot",
              "aggregateVersion",
              "versionNumber",
              "rootCreatedAt",
              "rootUpdatedAt",
              "precise",
            ]);
            if (
              row.precise !== true ||
              positiveVersion(row.versionNumber) > positiveVersion(row.aggregateVersion)
            )
              return fail();
            const createdAt = parseEffectivePeriodInstant(row.rootCreatedAt),
              updatedAt = parseEffectivePeriodInstant(row.rootUpdatedAt);
            const snapshot = closed(row.snapshot, [
              "ruleReference",
              "versionReference",
              "snapshotDigest",
              "brandReference",
              "bindingReference",
              "optionReference",
              "skuReference",
              "scopeKind",
              "scopeReference",
              "channelCode",
              "orderType",
              "lifecycle",
              "currencyMetadata",
              "unitAmount",
              "includedQuantity",
              "quantityBasis",
              "effectivePeriod",
              "createdAt",
            ]);
            const money = closed(snapshot.unitAmount, ["amountMinor", "currencyCode"]);
            if (
              typeof money.amountMinor !== "string" ||
              !/^(0|[1-9][0-9]{0,18})$/u.test(money.amountMinor)
            )
              return fail();
            const rule = createOptionPriceRuleSnapshot({
              ...snapshot,
              unitAmount: { ...money, amountMinor: BigInt(money.amountMinor) },
            } as unknown as OptionPriceRuleSnapshot);
            const scopeReference =
              rule.scopeKind === "Brand"
                ? null
                : rule.scopeKind === "Store"
                  ? store
                  : rule.scopeKind === "StoreGroup"
                    ? group
                    : region;
            if (
              rule.brandReference !== brand ||
              rule.bindingReference !== binding ||
              rule.optionReference !== choice ||
              (rule.skuReference !== null && rule.skuReference !== sku) ||
              rule.scopeReference !== scopeReference ||
              (rule.channelCode !== null && rule.channelCode !== channel) ||
              (rule.orderType !== null && rule.orderType !== orderType) ||
              JSON.stringify(rule.currencyMetadata) !== JSON.stringify(currency) ||
              createdAt > rule.createdAt ||
              rule.createdAt > updatedAt ||
              updatedAt > observedAt ||
              ids.has(rule.ruleReference)
            )
              return fail();
            ids.add(rule.ruleReference);
            return rule;
          });
          return Object.freeze(
            snapshots.filter(
              (rule) =>
                rule.lifecycle === "Published" &&
                rule.effectivePeriod.effectiveFrom.instant <= observedAt &&
                (rule.effectivePeriod.effectiveUntil === null ||
                  observedAt < rule.effectivePeriod.effectiveUntil.instant),
            ),
          );
        });
      } catch {
        return fail();
      }
    },
  });
}
