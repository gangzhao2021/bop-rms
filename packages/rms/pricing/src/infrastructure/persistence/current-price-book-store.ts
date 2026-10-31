import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  createCurrencyMetadataSnapshot,
  parsePricingReference,
  type CurrencyMetadataSnapshot,
} from "../../domain/money-tax-contract.js";
import { createPriceBookSnapshot, type PriceBookSnapshot } from "../../domain/price-resolution.js";
import type { PriceQuoteQueryTransactionRunner } from "./price-quote-query-store.js";

export class CurrentPriceBookError extends Error {
  readonly code = "CURRENT_PRICE_BOOK_UNAVAILABLE";
  constructor() {
    super("current price book is unavailable");
    this.name = "CurrentPriceBookError";
  }
}
function fail(): never {
  throw new CurrentPriceBookError();
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
 'priceBookReference',b.price_book_id,'versionReference',v.price_book_version_id,
 'brandReference',b.brand_id,'stableCode',b.stable_code,'aggregateVersion',b.aggregate_version,
 'versionNumber',v.version_number,'snapshotDigest',v.snapshot_digest,'lifecycle',v.lifecycle,
 'currencyMetadata',jsonb_build_object('currencyCode',v.currency_code,
   'metadataVersion',v.currency_metadata_version,'metadataVersionReference',v.currency_metadata_version_id,
   'metadataDigest',v.currency_metadata_digest),
 'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'entries',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'entryReference',e.price_entry_id,'sellableReference',e.sellable_id,'scopeKind',e.scope_kind,
   'scopeReference',e.scope_id,'channelCode',e.channel_code,'orderType',e.order_type,
   'amount',jsonb_build_object('amountMinor',e.amount_minor::text,'currencyCode',e.currency_code),
   'effectivePeriod',jsonb_build_object('timeZone',e.effective_time_zone,
     'effectiveFrom',jsonb_build_object('instant',to_char(e.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localDateTime',to_char(e.effective_from AT TIME ZONE e.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((e.effective_from AT TIME ZONE e.effective_time_zone)-(e.effective_from AT TIME ZONE 'UTC')))/60),'effectiveUntil',CASE WHEN e.effective_until IS NULL THEN NULL ELSE jsonb_build_object('instant',to_char(e.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localDateTime',to_char(e.effective_until AT TIME ZONE e.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((e.effective_until AT TIME ZONE e.effective_time_zone)-(e.effective_until AT TIME ZONE 'UTC')))/60) END),
   'reasonCode',e.reason_code) ORDER BY e.price_entry_id)
 FROM rms_pricing.price_entry e WHERE e.brand_id=b.brand_id AND e.price_book_id=b.price_book_id
 AND e.price_book_version_id=v.price_book_version_id),'[]'::jsonb)
) AS snapshot,
 (date_trunc('milliseconds',v.created_at)=v.created_at
 AND date_trunc('milliseconds',b.updated_at)=b.updated_at
 AND NOT EXISTS (SELECT 1 FROM rms_pricing.price_entry e
 WHERE e.brand_id=b.brand_id AND e.price_book_id=b.price_book_id AND e.price_book_version_id=v.price_book_version_id
 AND (date_trunc('milliseconds',e.effective_from)<>e.effective_from
 OR date_trunc('milliseconds',e.effective_until)<>e.effective_until))) AS precise
FROM rms_pricing.price_book b JOIN rms_pricing.price_book_version v
 ON v.price_book_version_id=b.current_version_id AND v.price_book_id=b.price_book_id AND v.brand_id=b.brand_id
WHERE b.brand_id=$1 AND b.price_book_id=$2 AND v.lifecycle='Published'
 AND b.created_at <= $3::timestamptz AND b.updated_at <= $3::timestamptz AND v.created_at <= $3::timestamptz`;

/** Owner configuration read, not Guest authorization or final quote/Inventory readiness.
 * Currency metadata must come from the caller's explicit versioned currency authority. */
export function createPostgresCurrentPriceBookStore(
  runner: PriceQuoteQueryTransactionRunner,
  scope: Readonly<{ brandReference: string }>,
  currencyInput: CurrencyMetadataSnapshot,
) {
  const brand = parsePricingReference(closed(scope, ["brandReference"]).brandReference);
  const currency = createCurrencyMetadataSnapshot(currencyInput);
  return Object.freeze({
    async load(
      input: Readonly<{ priceBookReference: string; observedAt: string }>,
    ): Promise<PriceBookSnapshot | null> {
      try {
        const raw = closed(input, ["priceBookReference", "observedAt"]);
        const reference = parsePricingReference(raw.priceBookReference);
        const observedAt = parseEffectivePeriodInstant(raw.observedAt);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, ""],
          );
          const result = await tx.query(select, [brand, reference, observedAt]);
          if (result === null || typeof result !== "object") fail();
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(rows) || rows.length > 1) fail();
          if (rows.length === 0) return null;
          const envelope = closed(rows[0], ["snapshot", "precise"]);
          const row = closed(envelope.snapshot, [
            "priceBookReference",
            "versionReference",
            "brandReference",
            "stableCode",
            "aggregateVersion",
            "versionNumber",
            "snapshotDigest",
            "lifecycle",
            "currencyMetadata",
            "entries",
            "createdAt",
          ]);
          if (envelope.precise !== true) fail();
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
          if (!Array.isArray(row.entries)) fail();
          const entries = row.entries.map((value: unknown) => {
            const entry = closed(value, [
              "entryReference",
              "sellableReference",
              "scopeKind",
              "scopeReference",
              "channelCode",
              "orderType",
              "amount",
              "effectivePeriod",
              "reasonCode",
            ]);
            const money = closed(entry.amount, ["amountMinor", "currencyCode"]);
            if (
              typeof money.amountMinor !== "string" ||
              !/^(0|[1-9][0-9]*)$/u.test(money.amountMinor)
            )
              fail();
            return { ...entry, amount: { ...money, amountMinor: BigInt(money.amountMinor) } };
          });
          const snapshot = createPriceBookSnapshot({
            ...row,
            entries,
            currencyMetadata: currency,
          } as unknown as PriceBookSnapshot);
          if (
            snapshot.brandReference !== brand ||
            snapshot.priceBookReference !== reference ||
            snapshot.lifecycle !== "Published" ||
            snapshot.createdAt > observedAt
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
