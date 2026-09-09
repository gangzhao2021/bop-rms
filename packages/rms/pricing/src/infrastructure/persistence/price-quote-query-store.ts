import { parsePricingReference } from "../../domain/money-tax-contract.js";
import type { PriceQuoteSnapshot } from "../../domain/price-quote.js";
import { decodePriceQuoteSnapshot } from "../../domain/price-quote-snapshot-codec.js";

export interface PriceQuoteQueryTransaction {
  query(sql: string, parameters: readonly unknown[]): Promise<unknown>;
}
export interface PriceQuoteQueryTransactionRunner {
  run<T>(action: (transaction: PriceQuoteQueryTransaction) => Promise<T>): Promise<T>;
}
export interface PriceQuoteHistoryReader {
  load(quoteReference: string): Promise<PriceQuoteSnapshot | null>;
}
export class PriceQuoteQueryError extends Error {
  readonly code = "QUOTE_HISTORY_UNAVAILABLE";
  constructor() {
    super("price quote history is unavailable");
    this.name = "PriceQuoteQueryError";
  }
}
function fail(): never {
  throw new PriceQuoteQueryError();
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail();
    result[field] = descriptor.value;
  }
  return result;
}

const select = `SELECT q.complete_snapshot_text AS "snapshotText", jsonb_build_object(
 'quoteReference',q.price_quote_id,'quoteVersion',q.quote_version,
 'brandReference',q.brand_id,'storeReference',q.store_id,'cartReference',q.cart_id,
 'cartVersion',q.cart_version,'inputDigest',q.input_digest,'currencyCode',q.currency_code,
 'currencyMetadataVersion',q.currency_metadata_version,
 'currencyMetadataVersionReference',q.currency_metadata_version_id,
 'currencyMetadataDigest',q.currency_metadata_digest,
 'subtotal',q.subtotal_minor::text,'discount',q.discount_minor::text,
 'tax',q.tax_minor::text,'fee',q.fee_minor::text,'total',q.total_minor::text,
 'appliedPromotionReferences',q.applied_promotion_references_json::text,
 'warnings',q.warnings_json::text,'blockingReasons',q.blocking_reasons_json::text,
 'createdAt',to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'expiresAt',to_char(q.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 ) AS summary FROM rms_pricing.price_quote q
 WHERE q.brand_id=$1 AND q.store_id=$2 AND q.price_quote_id=$3`;

function expectedSummary(quote: PriceQuoteSnapshot): Record<string, unknown> {
  return {
    quoteReference: quote.quoteReference,
    quoteVersion: quote.quoteVersion,
    brandReference: quote.brandReference,
    storeReference: quote.storeReference,
    cartReference: quote.cartReference,
    cartVersion: quote.cartVersion,
    inputDigest: quote.inputDigest,
    currencyCode: quote.currencyMetadata.currencyCode,
    currencyMetadataVersion: quote.currencyMetadata.metadataVersion,
    currencyMetadataVersionReference: quote.currencyMetadata.metadataVersionReference,
    currencyMetadataDigest: quote.currencyMetadata.metadataDigest,
    subtotal: quote.subtotal.amountMinor.toString(),
    discount: quote.discount.amountMinor.toString(),
    tax: quote.tax.amountMinor.toString(),
    fee: quote.fee.amountMinor.toString(),
    total: quote.total.amountMinor.toString(),
    appliedPromotionReferences: JSON.stringify(quote.appliedPromotionReferences),
    warnings: JSON.stringify(quote.warnings),
    blockingReasons: JSON.stringify(quote.blockingReasons),
    createdAt: quote.createdAt.replace("Z", "000Z"),
    expiresAt: quote.expiresAt.replace("Z", "000Z"),
  };
}

/** Historical owner read only. Caller supplies authorization; this does not establish current validity. */
export function createPostgresPriceQuoteHistoryReader(
  runner: PriceQuoteQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
): PriceQuoteHistoryReader {
  let brand: string;
  let store: string;
  try {
    const raw = closed(scope, ["brandReference", "storeReference"]);
    brand = parsePricingReference(raw.brandReference);
    store = parsePricingReference(raw.storeReference);
  } catch {
    return fail();
  }
  return Object.freeze({
    async load(quoteReference: string): Promise<PriceQuoteSnapshot | null> {
      try {
        const reference = parsePricingReference(quoteReference);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          const result = await tx.query(select, [brand, store, reference]);
          if (result === null || typeof result !== "object") fail();
          const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            !Array.isArray(descriptor.value)
          )
            fail();
          const rows: unknown[] = descriptor.value;
          if (rows.length === 0) return null;
          if (rows.length !== 1) fail();
          const rowDescriptor = Object.getOwnPropertyDescriptor(rows, "0");
          if (rowDescriptor === undefined || !("value" in rowDescriptor)) fail();
          const row = closed(rowDescriptor.value, ["snapshotText", "summary"]);
          if (typeof row.snapshotText !== "string") fail();
          const quote = decodePriceQuoteSnapshot(row.snapshotText);
          if (
            quote.quoteReference !== reference ||
            quote.brandReference !== brand ||
            quote.storeReference !== store
          )
            fail();
          const expected = expectedSummary(quote);
          const summary = closed(row.summary, Object.keys(expected));
          if (Object.entries(expected).some(([key, value]) => summary[key] !== value)) fail();
          return quote;
        });
      } catch {
        return fail();
      }
    },
  });
}
