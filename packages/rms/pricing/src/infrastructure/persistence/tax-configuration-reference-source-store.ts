import {
  parseTaxConfigurationReferenceSourceRequest,
  type TaxConfigurationReferenceSourceRequest,
} from "../../contracts/tax-configuration-reference-source.js";
import { parsePricingReference } from "../../domain/money-tax-contract.js";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  TaxConfigurationReferenceSourceError,
  buildTaxConfigurationReferenceSourceSnapshot,
  taxConfigurationReferenceSourceFields,
  taxConfigurationReferenceSourceMaximumRows,
  type TaxConfigurationReferenceSourceSnapshot,
} from "../../contracts/tax-configuration-reference-source.js";
import type { PriceQuoteQueryTransaction } from "./price-quote-query-store.js";
export interface TaxConfigurationReferenceSourceAuthority {
  /** Actual current Tenant/Brand/Store/Actor, purpose/permission/fields/Phase through caller COMMIT. */
  holdUntilTransactionCompletes(
    tx: PriceQuoteQueryTransaction,
    input: {
      readonly tenantReference: string;
      readonly request: TaxConfigurationReferenceSourceRequest;
      readonly permission: "pricing.tax-config.manage";
      readonly requiredFields: typeof taxConfigurationReferenceSourceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const limit = taxConfigurationReferenceSourceMaximumRows + 1;
const select = `SELECT jsonb_build_object('observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},'references',(SELECT COALESCE(jsonb_agg(row_value),'[]'::jsonb) FROM
 (SELECT jsonb_build_object('root',jsonb_build_object('configurationReference',r.tax_configuration_id,'brandReference',r.brand_id,'storeReference',r.store_id,'aggregateVersion',r.aggregate_version,'currentVersionReference',r.current_version_id,'rootCreatedAt',${utc("r.created_at")},'updatedAt',${utc("r.updated_at")}),
 'version',CASE WHEN v.tax_configuration_version_id IS NULL THEN NULL ELSE jsonb_build_object('versionReference',v.tax_configuration_version_id,'versionNumber',v.version_number,'snapshotDigest',v.snapshot_digest,'lifecycle',v.lifecycle,'timeZone',v.effective_time_zone,'effectiveFrom',${utc("v.effective_from")},'effectiveUntil',${utc("v.effective_until")},'createdAt',${utc("v.created_at")},
 'rules',(SELECT COALESCE(jsonb_agg(reference ORDER BY reference->>'ruleReference'),'[]'::jsonb) FROM (SELECT jsonb_build_object('ruleReference',t.tax_configuration_rule_id,'taxClassificationReference',t.tax_classification_id,'orderType',t.order_type,'chargeType',t.charge_type,'taxComponentCode',t.tax_component_code) reference FROM rms_pricing.tax_configuration_rule t WHERE t.tax_configuration_id=r.tax_configuration_id AND t.brand_id=r.brand_id AND t.store_id=r.store_id AND t.tax_configuration_version_id=v.tax_configuration_version_id ORDER BY t.tax_configuration_rule_id LIMIT ${limit}) bounded_rules)) END,
 'precise',date_trunc('milliseconds',r.created_at)=r.created_at AND date_trunc('milliseconds',r.updated_at)=r.updated_at AND (v.tax_configuration_version_id IS NULL OR (date_trunc('milliseconds',v.created_at)=v.created_at AND date_trunc('milliseconds',v.effective_from)=v.effective_from AND (v.effective_until IS NULL OR date_trunc('milliseconds',v.effective_until)=v.effective_until)))) row_value
 FROM rms_pricing.tax_configuration r LEFT JOIN rms_pricing.tax_configuration_version v ON v.tax_configuration_id=r.tax_configuration_id AND v.brand_id=r.brand_id AND v.store_id=r.store_id WHERE r.brand_id=$1 AND r.store_id=$2 ORDER BY r.tax_configuration_id,v.tax_configuration_version_id LIMIT ${limit}) bounded)) source`;
const fail = (): never => {
  throw new TaxConfigurationReferenceSourceError();
};
/** Selected Store roots/all versions/rules only; never cross-Store, legal approval or held writer coverage. */
export function createPostgresTaxConfigurationReferenceSourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: PriceQuoteQueryTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: TaxConfigurationReferenceSourceAuthority;
  readonly clock: { now(): string };
}): {
  loadSnapshot(
    value: TaxConfigurationReferenceSourceRequest,
  ): Promise<TaxConfigurationReferenceSourceSnapshot>;
} {
  const tenantReference = parsePricingReference(options.tenantReference),
    brand = parsePricingReference(options.brandReference),
    actor = parsePricingReference(options.actorReference),
    store = parsePricingReference(options.storeReference);
  return Object.freeze({
    async loadSnapshot(value) {
      try {
        const request = parseTaxConfigurationReferenceSourceRequest(value);
        if (
          request.brandReference !== brand ||
          request.actorReference !== actor ||
          request.storeReference !== store
        )
          return fail();
        let calls = 0,
          selected: TaxConfigurationReferenceSourceSnapshot | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference,
                request,
                permission: "pricing.tax-config.manage",
                requiredFields: taxConfigurationReferenceSourceFields,
                observedAt: parseEffectivePeriodInstant(options.clock.now()),
              }),
            );
          await authorize();
          const isolation = await tx.query(
              "SELECT current_setting('transaction_isolation') isolation",
              [],
            ),
            rows = Object.getOwnPropertyDescriptor(isolation, "rows")?.value;
          if (
            !Array.isArray(rows) ||
            rows.length !== 1 ||
            Object.getOwnPropertyDescriptor(rows[0], "isolation")?.value !== "read committed"
          )
            return fail();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true),set_config('statement_timeout','60000',true)",
            [brand, store],
          );
          const result = await tx.query(select, [brand, store]),
            d = Object.getOwnPropertyDescriptor(result, "rows");
          if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length !== 1)
            return fail();
          const row = Object.getOwnPropertyDescriptor(d.value, "0")?.value;
          if (!row || Reflect.ownKeys(row).length !== 1) return fail();
          const source = Object.getOwnPropertyDescriptor(row, "source");
          if (!source?.enumerable || !("value" in source)) return fail();
          selected = buildTaxConfigurationReferenceSourceSnapshot(
            source.value,
            request,
            options.clock.now(),
          );
          await authorize();
          return selected;
        });
        if (calls !== 1 || !selected || result !== selected) return fail();
        const at = parseEffectivePeriodInstant(options.clock.now());
        if (at < selected.observedAt || Date.parse(at) - Date.parse(selected.observedAt) > 5000)
          return fail();
        return selected;
      } catch {
        return fail();
      }
    },
  });
}
