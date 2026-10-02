import { parsePricingReference } from "../../domain/money-tax-contract.js";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  PriceBookReferenceSourceError,
  parsePriceBookReferenceSourceRequest,
  buildPriceBookReferenceSourceSnapshot,
  priceBookReferenceSourceFields,
  priceBookReferenceSourceMaximumRows,
  type PriceBookReferenceSourceRequest,
  type PriceBookReferenceSourceSnapshot,
} from "../../contracts/price-book-reference-source.js";
import type { PriceQuoteQueryTransaction } from "./price-quote-query-store.js";
export interface PriceBookReferenceSourceAuthority {
  /** Actual current Tenant/Brand/Actor, purpose/permission/fields/Phase through caller COMMIT. */
  holdUntilTransactionCompletes(
    tx: PriceQuoteQueryTransaction,
    input: {
      readonly tenantReference: string;
      readonly request: PriceBookReferenceSourceRequest;
      readonly permission: "pricing.price-book.manage";
      readonly requiredFields: typeof priceBookReferenceSourceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const select = `SELECT jsonb_build_object('observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
'references',(SELECT COALESCE(jsonb_agg(row_value),'[]'::jsonb) FROM
 (SELECT jsonb_build_object('reference',jsonb_build_object(
 'priceBookReference',b.price_book_id,'brandReference',b.brand_id,'aggregateVersion',b.aggregate_version,
 'currentVersionReference',b.current_version_id,'updatedAt',${utc("b.updated_at")},
 'versionReference',v.price_book_version_id,'versionNumber',v.version_number,'snapshotDigest',v.snapshot_digest,
 'lifecycle',v.lifecycle,'createdAt',${utc("v.created_at")},'entryReference',e.price_entry_id,'sellableReference',e.sellable_id,
 'scopeKind',e.scope_kind,'scopeReference',e.scope_id,'channelCode',e.channel_code,'orderType',e.order_type,
 'timeZone',e.effective_time_zone,'effectiveFrom',${utc("e.effective_from")},'effectiveUntil',${utc("e.effective_until")}),
 'precise',date_trunc('milliseconds',b.updated_at)=b.updated_at AND date_trunc('milliseconds',v.created_at)=v.created_at AND
 date_trunc('milliseconds',e.effective_from)=e.effective_from AND (e.effective_until IS NULL OR date_trunc('milliseconds',e.effective_until)=e.effective_until)) row_value
 FROM rms_pricing.price_entry e JOIN rms_pricing.price_book_version v ON v.price_book_version_id=e.price_book_version_id AND v.price_book_id=e.price_book_id AND v.brand_id=e.brand_id
 JOIN rms_pricing.price_book b ON b.price_book_id=v.price_book_id AND b.brand_id=v.brand_id
 WHERE e.brand_id=$1 ORDER BY e.price_entry_id LIMIT ${priceBookReferenceSourceMaximumRows + 1}) bounded)) source`;
const fail = (): never => {
  throw new PriceBookReferenceSourceError();
};
/** Statement snapshot includes every version/scope/channel/period; not held writers or full Pricing coverage. */
export function createPostgresPriceBookReferenceSourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: PriceQuoteQueryTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: PriceBookReferenceSourceAuthority;
  readonly clock: { now(): string };
}): {
  loadSnapshot(value: PriceBookReferenceSourceRequest): Promise<PriceBookReferenceSourceSnapshot>;
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
          selected: PriceBookReferenceSourceSnapshot | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference,
                request,
                permission: "pricing.price-book.manage",
                requiredFields: priceBookReferenceSourceFields,
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
          selected = buildPriceBookReferenceSourceSnapshot(
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
