import {
  parsePriceBookReferenceSourceRequest,
  type PriceBookReferenceSourceRequest,
} from "../../contracts/price-book-reference-source.js";
import { parsePricingReference } from "../../domain/money-tax-contract.js";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  PromotionReferenceSourceError,
  buildPromotionReferenceSourceSnapshot,
  promotionReferenceSourceFields,
  promotionReferenceSourceMaximumRows,
  type PromotionReferenceSourceSnapshot,
} from "../../contracts/promotion-reference-source.js";
import type { PriceQuoteQueryTransaction } from "./price-quote-query-store.js";
export interface PromotionReferenceSourceAuthority {
  /** Actual current Tenant/Brand/Actor, purpose/permission/fields/Phase through caller COMMIT. */
  holdUntilTransactionCompletes(
    tx: PriceQuoteQueryTransaction,
    input: {
      readonly tenantReference: string;
      readonly request: PriceBookReferenceSourceRequest;
      readonly permission: "pricing.promotion.manage";
      readonly requiredFields: typeof promotionReferenceSourceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const select = `SELECT jsonb_build_object('observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
'references',(SELECT COALESCE(jsonb_agg(row_value),'[]'::jsonb) FROM
 (SELECT jsonb_build_object('root',jsonb_build_object(
 'promotionReference',r.promotion_id,'brandReference',r.brand_id,'aggregateVersion',r.aggregate_version,'currentVersionReference',r.current_version_id,'rootCreatedAt',${utc("r.created_at")},'updatedAt',${utc("r.updated_at")}),
 'version',CASE WHEN v.promotion_version_id IS NULL THEN NULL ELSE jsonb_build_object(
 'versionReference',v.promotion_version_id,'versionNumber',v.version_number,'snapshotDigest',v.snapshot_digest,'lifecycle',v.lifecycle,'promotionType',v.promotion_type,'benefitScope',v.benefit_scope,
 'timeZone',v.effective_time_zone,'effectiveFrom',${utc("v.effective_from")},'effectiveUntil',${utc("v.effective_until")},'createdAt',${utc("v.created_at")},
 'eligibility',(SELECT COALESCE(jsonb_agg(qualifier),'[]'::jsonb) FROM (SELECT jsonb_build_object('eligibilityReference',e.promotion_eligibility_reference_id,'referenceKind',e.reference_kind,'publicReference',e.public_reference_id) qualifier
 FROM rms_pricing.promotion_eligibility_reference e WHERE e.promotion_version_id=v.promotion_version_id AND e.promotion_id=r.promotion_id AND e.brand_id=r.brand_id
 ORDER BY e.promotion_eligibility_reference_id LIMIT ${promotionReferenceSourceMaximumRows + 1}) bounded_eligibility)) END,
 'precise',date_trunc('milliseconds',r.created_at)=r.created_at AND date_trunc('milliseconds',r.updated_at)=r.updated_at AND
 (v.promotion_version_id IS NULL OR (date_trunc('milliseconds',v.created_at)=v.created_at AND date_trunc('milliseconds',v.effective_from)=v.effective_from AND
 (v.effective_until IS NULL OR date_trunc('milliseconds',v.effective_until)=v.effective_until)))) row_value
 FROM rms_pricing.promotion r LEFT JOIN rms_pricing.promotion_version v ON v.promotion_id=r.promotion_id AND v.brand_id=r.brand_id
 WHERE r.brand_id=$1 ORDER BY r.promotion_id,v.promotion_version_id LIMIT ${promotionReferenceSourceMaximumRows + 1}) bounded)) source`;
const fail = (): never => {
  throw new PromotionReferenceSourceError();
};
/** Statement snapshot includes unversioned roots and every version/scope/channel/period; not held writers or full Pricing coverage. */
export function createPostgresPromotionReferenceSourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: PriceQuoteQueryTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: PromotionReferenceSourceAuthority;
  readonly clock: { now(): string };
}): {
  loadSnapshot(value: PriceBookReferenceSourceRequest): Promise<PromotionReferenceSourceSnapshot>;
} {
  const tenantReference = parsePricingReference(options.tenantReference),
    brand = parsePricingReference(options.brandReference),
    actor = parsePricingReference(options.actorReference);
  return Object.freeze({
    async loadSnapshot(value) {
      try {
        const request = parsePriceBookReferenceSourceRequest(value);
        if (request.brandReference !== brand || request.actorReference !== actor) return fail();
        let calls = 0,
          selected: PromotionReferenceSourceSnapshot | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference,
                request,
                permission: "pricing.promotion.manage",
                requiredFields: promotionReferenceSourceFields,
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
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
            [brand],
          );
          const result = await tx.query(select, [brand]),
            d = Object.getOwnPropertyDescriptor(result, "rows");
          if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length !== 1)
            return fail();
          const row = Object.getOwnPropertyDescriptor(d.value, "0")?.value;
          if (!row || Reflect.ownKeys(row).length !== 1) return fail();
          const source = Object.getOwnPropertyDescriptor(row, "source");
          if (!source?.enumerable || !("value" in source)) return fail();
          selected = buildPromotionReferenceSourceSnapshot(
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
