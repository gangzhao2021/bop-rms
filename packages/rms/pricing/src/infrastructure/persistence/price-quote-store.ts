import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { parsePricingReference } from "../../domain/money-tax-contract.js";
import type { PriceQuoteSnapshot } from "../../domain/price-quote.js";
import {
  encodePriceQuoteSnapshot,
  decodePriceQuoteSnapshot,
} from "../../domain/price-quote-snapshot-codec.js";
import {
  createPostgresPriceQuoteHistoryReader,
  type PriceQuoteQueryTransactionRunner,
} from "./price-quote-query-store.js";

export interface PriceQuoteStore {
  append(input: {
    readonly quote: PriceQuoteSnapshot;
    readonly audit: AppendAuditRecordInput;
  }): Promise<Readonly<{ status: "Created" | "Existing"; quote: PriceQuoteSnapshot }>>;
}
export class PriceQuoteStoreError extends Error {
  constructor(readonly code: "QUOTE_WRITE_UNAVAILABLE" | "QUOTE_SNAPSHOT_CONFLICT") {
    super("price quote could not be saved");
    this.name = "PriceQuoteStoreError";
  }
}
function fail(): never {
  throw new PriceQuoteStoreError("QUOTE_WRITE_UNAVAILABLE");
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
  return Object.fromEntries(
    fields.map((key) => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail();
      return [key, descriptor.value];
    }),
  );
}
function witness(value: unknown, reference: string): void {
  if (value === null || typeof value !== "object") fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (descriptor === undefined || !("value" in descriptor) || !Array.isArray(descriptor.value))
    fail();
  const rows: unknown[] = descriptor.value;
  if (rows.length !== 1) fail();
  const first = Object.getOwnPropertyDescriptor(rows, "0");
  if (
    first === undefined ||
    !("value" in first) ||
    closed(first.value, ["reference"]).reference !== reference
  )
    fail();
}
const insertRoot = `INSERT INTO rms_pricing.price_quote
 (price_quote_id,quote_version,brand_id,store_id,cart_id,cart_version,input_digest,currency_code,
  currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,subtotal_minor,
  discount_minor,tax_minor,fee_minor,total_minor,applied_promotion_references_json,warnings_json,
  blocking_reasons_json,created_at,expires_at,complete_snapshot_text)
 VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21)
 RETURNING price_quote_id AS reference`;
const insertLine = `INSERT INTO rms_pricing.price_quote_line
 (price_quote_line_id,price_quote_id,brand_id,store_id,sellable_id,product_version_id,menu_version_id,
  quantity,currency_code,unit_price_minor,subtotal_minor,discount_minor,tax_minor,fee_minor,total_minor,
  price_book_id,price_book_version_id,price_book_snapshot_digest,price_entry_id,tax_configuration_id,
  tax_configuration_version_id,tax_configuration_snapshot_digest,source_cart_line_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
 RETURNING price_quote_line_id AS reference`;
const insertTax = `INSERT INTO rms_pricing.price_quote_tax_line
 (price_quote_tax_line_id,price_quote_id,price_quote_line_id,brand_id,store_id,rule_version_id,
  tax_component_code,tax_classification_id,treatment,rate_decimal,price_inclusion,rounding_mode,
  calculation_order,compound_on_prior_tax,tax_minor,currency_code)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
 RETURNING price_quote_tax_line_id AS reference`;

/** Scoped append identity only; application authorization and operation idempotency remain caller duties. */
export function createPostgresPriceQuoteStore(
  runner: PriceQuoteQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  references: { generateReference(): string },
): PriceQuoteStore {
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
    async append(input: Parameters<PriceQuoteStore["append"]>[0]) {
      try {
        const raw = closed(input, ["quote", "audit"]);
        const encoded = encodePriceQuoteSnapshot(raw.quote as PriceQuoteSnapshot);
        const quote = decodePriceQuoteSnapshot(encoded);
        if (quote.brandReference !== brand || quote.storeReference !== store) fail();
        const auditInput = closed(raw.audit, [
          "auditId",
          "brandId",
          "storeId",
          "actor",
          "actionCode",
          "targetType",
          "targetId",
          "reasonCode",
          "correlationId",
          "occurredAt",
          "sourceChannel",
          "dataClassification",
          "retentionPolicyCode",
          "retentionPolicyVersion",
        ]);
        if (
          closed(auditInput.actor, ["type"]).type !== "System" ||
          Object.entries(auditInput).some(
            ([key, value]) =>
              key !== "actor" &&
              (key === "retentionPolicyVersion"
                ? typeof value !== "number"
                : typeof value !== "string"),
          )
        )
          fail();
        const audit = validateAuditRecord(
          Object.freeze({ ...auditInput, actor: Object.freeze({ type: "System" }) }),
          Date.parse(quote.createdAt),
        );
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "PRICING_QUOTE_CREATE" ||
          audit.targetType !== "PricingPriceQuote" ||
          audit.targetId !== quote.quoteReference ||
          audit.reasonCode !== "AUTHORIZED_CART_QUOTE" ||
          audit.occurredAt !== quote.createdAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined ||
          audit.deviceNetworkReference !== undefined ||
          audit.correctsAuditId !== undefined
        )
          fail();
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          // Immutable UPDATE rules preclude ON CONFLICT; serialize this Quote identity before lookup.
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `pricing.quote:${quote.quoteReference}`,
          ]);
          const reader = createPostgresPriceQuoteHistoryReader(
            { run: async (action) => action(tx) },
            { brandReference: brand, storeReference: store },
          );
          const prior = await reader.load(quote.quoteReference);
          if (prior !== null) {
            if (encodePriceQuoteSnapshot(prior) !== encoded)
              throw new PriceQuoteStoreError("QUOTE_SNAPSHOT_CONFLICT");
            return Object.freeze({ status: "Existing" as const, quote: prior });
          }
          witness(
            await tx.query(insertRoot, [
              quote.quoteReference,
              brand,
              store,
              quote.cartReference,
              quote.cartVersion,
              quote.inputDigest,
              quote.currencyMetadata.currencyCode,
              quote.currencyMetadata.metadataVersion,
              quote.currencyMetadata.metadataVersionReference,
              quote.currencyMetadata.metadataDigest,
              quote.subtotal.amountMinor.toString(),
              quote.discount.amountMinor.toString(),
              quote.tax.amountMinor.toString(),
              quote.fee.amountMinor.toString(),
              quote.total.amountMinor.toString(),
              JSON.stringify(quote.appliedPromotionReferences),
              JSON.stringify(quote.warnings),
              JSON.stringify(quote.blockingReasons),
              quote.createdAt,
              quote.expiresAt,
              encoded,
            ]),
            quote.quoteReference,
          );
          const used = new Set<string>([
            quote.quoteReference,
            audit.auditId,
            ...quote.lines.map((line) => line.lineReference),
          ]);
          const fresh = () => {
            const id = parsePricingReference(references.generateReference());
            if (used.has(id)) fail();
            used.add(id);
            return id;
          };
          for (const line of quote.lines) {
            const physical = fresh();
            const price = line.resolvedPrice;
            const tax = line.taxResolution;
            witness(
              await tx.query(insertLine, [
                physical,
                quote.quoteReference,
                brand,
                store,
                line.sellableReference,
                line.productVersionReference,
                line.menuVersionReference,
                line.quantity,
                line.unitPrice.currencyCode,
                line.unitPrice.amountMinor.toString(),
                line.subtotal.amountMinor.toString(),
                line.discount.amountMinor.toString(),
                line.tax.amountMinor.toString(),
                line.fee.amountMinor.toString(),
                line.total.amountMinor.toString(),
                price.priceBookReference,
                price.versionReference,
                price.snapshotDigest,
                price.entryReference,
                tax.configurationReference,
                tax.versionReference,
                tax.snapshotDigest,
                line.lineReference,
              ]),
              physical,
            );
            for (const component of line.taxLines) {
              const taxId = fresh();
              const explanation = component.explanation;
              witness(
                await tx.query(insertTax, [
                  taxId,
                  quote.quoteReference,
                  physical,
                  brand,
                  store,
                  component.ruleReference,
                  explanation.taxComponentCode,
                  explanation.taxClassificationReference,
                  explanation.treatment,
                  explanation.rate,
                  explanation.priceInclusion,
                  explanation.roundingMode,
                  component.calculationOrder,
                  component.compoundOnPriorTax,
                  component.taxAmount.amountMinor.toString(),
                  component.taxAmount.currencyCode,
                ]),
                taxId,
              );
            }
          }
          const persisted = await reader.load(quote.quoteReference);
          if (persisted === null || encodePriceQuoteSnapshot(persisted) !== encoded) fail();
          await appendAuditRecordInTransaction(tx, audit);
          return Object.freeze({ status: "Created" as const, quote: persisted });
        });
      } catch (error) {
        if (error instanceof PriceQuoteStoreError && error.code === "QUOTE_SNAPSHOT_CONFLICT")
          throw error;
        return fail();
      }
    },
  });
}
