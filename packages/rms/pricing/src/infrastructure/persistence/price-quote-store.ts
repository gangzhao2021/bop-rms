import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  PriceQuoteStoreError,
  type PriceQuoteStore,
} from "../../application/ports/price-quote-store-ports.js";
import {
  decodePriceQuoteSnapshot,
  encodePriceQuoteSnapshot,
} from "../../contracts/price-quote-snapshot.js";
import { parsePricingReference, type PricingReference } from "../../domain/money-tax-contract.js";
import type { PriceQuoteLineSnapshot, PriceQuoteSnapshot } from "../../domain/price-quote.js";

export interface PriceQuoteDatabaseTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface PriceQuoteDatabaseRunner {
  run<T>(action: (transaction: PriceQuoteDatabaseTransaction) => Promise<T>): Promise<T>;
}
type RecordValue = Record<string, unknown>;
const unavailable = (): never => {
  throw new PriceQuoteStoreError("QUOTE_STORE_UNAVAILABLE");
};
function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : unavailable();
}
function rows(value: unknown): RecordValue[] {
  const result = object(value).rows;
  return Array.isArray(result) ? result.map(object) : unavailable();
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const left = a as RecordValue,
    right = b as RecordValue;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => Object.hasOwn(right, key) && same(left[key], right[key]))
  );
}
function matches(actual: RecordValue, expected: RecordValue): void {
  if (Object.entries(expected).some(([key, value]) => !same(actual[key], value))) unavailable();
}
function scope(q: PriceQuoteSnapshot) {
  return {
    price_quote_id: q.quoteReference,
    brand_id: q.brandReference,
    store_id: q.storeReference,
  };
}
function money(q: Pick<PriceQuoteSnapshot, "subtotal" | "discount" | "tax" | "fee" | "total">) {
  return {
    subtotal_minor: q.subtotal.amountMinor.toString(),
    discount_minor: q.discount.amountMinor.toString(),
    tax_minor: q.tax.amountMinor.toString(),
    fee_minor: q.fee.amountMinor.toString(),
    total_minor: q.total.amountMinor.toString(),
  };
}
function header(q: PriceQuoteSnapshot): RecordValue {
  return {
    ...scope(q),
    quote_version: q.quoteVersion,
    cart_id: q.cartReference,
    cart_version: q.cartVersion,
    input_digest: q.inputDigest,
    currency_code: q.currencyMetadata.currencyCode,
    currency_metadata_version: q.currencyMetadata.metadataVersion,
    currency_metadata_version_id: q.currencyMetadata.metadataVersionReference,
    currency_metadata_digest: q.currencyMetadata.metadataDigest,
    ...money(q),
    applied_promotion_references_json: q.appliedPromotionReferences,
    warnings_json: q.warnings,
    blocking_reasons_json: q.blockingReasons,
    created_at: q.createdAt,
    expires_at: q.expiresAt,
    snapshot_json: encodePriceQuoteSnapshot(q),
  };
}
function lineRow(q: PriceQuoteSnapshot, l: PriceQuoteLineSnapshot): RecordValue {
  return {
    ...scope(q),
    price_quote_line_id: l.lineReference,
    sellable_id: l.sellableReference,
    product_version_id: l.productVersionReference,
    menu_version_id: l.menuVersionReference,
    quantity: l.quantity,
    currency_code: l.unitPrice.currencyCode,
    unit_price_minor: l.unitPrice.amountMinor.toString(),
    ...money(l),
    price_book_id: l.resolvedPrice.priceBookReference,
    price_book_version_id: l.resolvedPrice.versionReference,
    price_book_snapshot_digest: l.resolvedPrice.snapshotDigest,
    price_entry_id: l.resolvedPrice.entryReference,
    tax_configuration_id: l.taxResolution.configurationReference,
    tax_configuration_version_id: l.taxResolution.versionReference,
    tax_configuration_snapshot_digest: l.taxResolution.snapshotDigest,
  };
}
function taxRows(q: PriceQuoteSnapshot, l: PriceQuoteLineSnapshot): RecordValue[] {
  return l.taxLines.map((t) => ({
    ...scope(q),
    price_quote_line_id: l.lineReference,
    rule_version_id: t.ruleReference,
    tax_component_code: t.explanation.taxComponentCode,
    tax_classification_id: t.explanation.taxClassificationReference,
    treatment: t.explanation.treatment,
    rate_decimal: t.explanation.rate,
    price_inclusion: t.explanation.priceInclusion,
    rounding_mode: t.explanation.roundingMode,
    calculation_order: t.calculationOrder,
    compound_on_prior_tax: t.compoundOnPriorTax,
    tax_minor: t.taxAmount.amountMinor.toString(),
    currency_code: t.taxAmount.currencyCode,
  }));
}
function audit(value: AppendAuditRecordInput, q: PriceQuoteSnapshot): AppendAuditRecordInput {
  const a = validateAuditRecord(value, Date.parse(q.createdAt));
  if (
    a.brandId !== q.brandReference ||
    a.storeId !== q.storeReference ||
    a.targetId !== q.quoteReference ||
    a.targetType !== "PricingQuote" ||
    a.actor.type !== "System" ||
    a.actionCode !== "PRICING_QUOTE_CREATE" ||
    a.reasonCode !== "AUTHORIZED_PRICE_QUOTE" ||
    a.sourceChannel !== "CUSTOMER_PWA" ||
    a.dataClassification !== "Restricted" ||
    a.occurredAt !== q.createdAt ||
    a.beforeSummary !== undefined ||
    a.afterSummary !== undefined
  )
    return unavailable();
  return a;
}
async function insert(
  tx: PriceQuoteDatabaseTransaction,
  table: "price_quote" | "price_quote_line" | "price_quote_tax_line",
  value: RecordValue,
) {
  // Keys and table names come only from the fixed owner mappings above, never caller input.
  const columns = Object.keys(value);
  const result = object(
    await tx.query(
      `INSERT INTO rms_pricing.${table} (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
      columns.map((key) => (key.endsWith("_json") ? JSON.stringify(value[key]) : value[key])),
    ),
  );
  if (result.rowCount !== 1) unavailable();
}
const taxKey = (r: RecordValue) =>
  `${String(r.price_quote_line_id)}:${String(r.calculation_order)}:${String(r.tax_component_code)}`;

export function createPostgresPriceQuoteStore(config: {
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly runner: PriceQuoteDatabaseRunner;
  readonly nextTaxLineReference: () => PricingReference;
}): PriceQuoteStore {
  const brand = parsePricingReference(config.brandReference),
    store = parsePricingReference(config.storeReference);
  async function guarded<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof PriceQuoteStoreError) throw error;
      return unavailable();
    }
  }
  async function load(tx: PriceQuoteDatabaseTransaction, reference: PricingReference) {
    const values = [brand, store, reference];
    // Cast bigint before JSON decoding; snapshot money is already canonical text.
    const found = rows(
      await tx.query(
        `SELECT to_jsonb(q) || jsonb_build_object('subtotal_minor',q.subtotal_minor::text,'discount_minor',q.discount_minor::text,'tax_minor',q.tax_minor::text,'fee_minor',q.fee_minor::text,'total_minor',q.total_minor::text) AS quote FROM rms_pricing.price_quote q WHERE brand_id=$1 AND store_id=$2 AND price_quote_id=$3`,
        values,
      ),
    );
    if (found.length === 0) return null;
    if (found.length !== 1) return unavailable();
    const h = object(found[0]?.quote);
    if (h.snapshot_json === null)
      throw new PriceQuoteStoreError("QUOTE_STORE_SNAPSHOT_UNAVAILABLE");
    const q = decodePriceQuoteSnapshot(h.snapshot_json);
    if (q.brandReference !== brand || q.storeReference !== store || q.quoteReference !== reference)
      return unavailable();
    for (const field of ["created_at", "expires_at"]) {
      if (typeof h[field] !== "string") return unavailable();
      h[field] = new Date(h[field]).toISOString();
    }
    matches(h, header(q));
    const actualLines = rows(
      await tx.query(
        `SELECT to_jsonb(l) || jsonb_build_object('unit_price_minor',l.unit_price_minor::text,'subtotal_minor',l.subtotal_minor::text,'discount_minor',l.discount_minor::text,'tax_minor',l.tax_minor::text,'fee_minor',l.fee_minor::text,'total_minor',l.total_minor::text) AS line FROM rms_pricing.price_quote_line l WHERE brand_id=$1 AND store_id=$2 AND price_quote_id=$3`,
        values,
      ),
    ).map((row) => object(row.line));
    const actualTaxes = rows(
      await tx.query(
        `SELECT to_jsonb(t) || jsonb_build_object('tax_minor',t.tax_minor::text) AS tax FROM rms_pricing.price_quote_tax_line t WHERE brand_id=$1 AND store_id=$2 AND price_quote_id=$3`,
        values,
      ),
    ).map((row) => object(row.tax));
    const expectedLines = q.lines.map((l) => lineRow(q, l));
    const expectedTaxes = q.lines.flatMap((l) => taxRows(q, l));
    if (actualLines.length !== expectedLines.length || actualTaxes.length !== expectedTaxes.length)
      return unavailable();
    const lineMap = new Map(actualLines.map((l) => [l.price_quote_line_id, l]));
    const taxMap = new Map(actualTaxes.map((t) => [taxKey(t), t]));
    if (lineMap.size !== actualLines.length || taxMap.size !== actualTaxes.length)
      return unavailable();
    for (const l of expectedLines) matches(object(lineMap.get(l.price_quote_line_id)), l);
    for (const t of expectedTaxes) {
      const actual = object(taxMap.get(taxKey(t)));
      parsePricingReference(actual.price_quote_tax_line_id);
      matches(actual, t);
    }
    return q;
  }
  return Object.freeze({
    load: (reference: PricingReference) =>
      guarded(() => {
        parsePricingReference(reference);
        return config.runner.run((tx) => load(tx, reference));
      }),
    save: (input: Parameters<PriceQuoteStore["save"]>[0]) =>
      guarded(async () => {
        const q = decodePriceQuoteSnapshot(encodePriceQuoteSnapshot(input.snapshot));
        if (q.brandReference !== brand || q.storeReference !== store) return unavailable();
        const a = audit(input.audit, q);
        return config.runner.run(async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `pricing-quote:${brand}:${store}:${q.quoteReference}`,
          ]);
          const existing = await load(tx, q.quoteReference);
          if (existing) {
            if (!same(encodePriceQuoteSnapshot(existing), encodePriceQuoteSnapshot(q)))
              throw new PriceQuoteStoreError("QUOTE_STORE_CONFLICT");
            return existing;
          }
          await insert(tx, "price_quote", header(q));
          for (const l of q.lines) {
            await insert(tx, "price_quote_line", lineRow(q, l));
            for (const t of taxRows(q, l))
              await insert(tx, "price_quote_tax_line", {
                price_quote_tax_line_id: parsePricingReference(config.nextTaxLineReference()),
                ...t,
              });
          }
          await appendAuditRecordInTransaction(tx, a);
          return q;
        });
      }),
  });
}
