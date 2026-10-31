import { appendAuditRecordInTransaction, type AppendAuditRecordInput } from "@bop/audit";
import { parsePricingDigest, parsePricingReference } from "../../domain/money-tax-contract.js";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 9 (coordinator 2026-10-31 rule 1): the
 * append-only record of each price book a Store charges of its own (migration 2000_139). A Store
 * price is a Store-scope entry in that book; the record says who changed which item from what to
 * what (StorePrice), or that a Brand listing was carried to the Store with its own prices kept
 * (BrandListing). The database refuses a record whose book changes anything but this Store's own
 * prices. Caller authorizes and owns the transaction; writes run in the Store scope.
 */
export type StorePriceChangeKind = "StorePrice" | "BrandListing";
export interface StorePriceChangeRecord {
  readonly operationReference: string;
  readonly changeKind: StorePriceChangeKind;
  readonly sellableReference: string | null;
  /** What the Store charged before (StorePrice), in minor units. */
  readonly previousAmountMinor: string | null;
  /** The Store's own price now; null: the Brand price (or a BrandListing). */
  readonly amountMinor: string | null;
  readonly currencyCode: string;
  readonly priceBookReference: string;
  readonly versionReference: string;
  readonly assignmentReference: string;
  readonly intentHash: string;
  readonly actorReference: string;
  readonly changedAt: string;
}
interface Tx {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
const minor = (value: string | null) => {
  if (value !== null && !/^(?:0|[1-9]\d{0,17})$/u.test(value))
    throw new Error("STORE_PRICE_CHANGE_INVALID");
  return value;
};
const storeScope = (tx: Tx, brand: string, store: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
const recordSql = `SELECT operation_id::text operation,change_kind,sellable_id::text sellable,
  previous_amount_minor::text previous,amount_minor::text amount,currency_code,price_book_id::text book,
  price_book_version_id::text version,assignment_id::text assignment,intent_hash,actor_id::text actor,
  to_char(changed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') changed_at
 FROM rms_pricing.store_price_change WHERE brand_id=$1 AND store_id=$2`;
const recordOf = (row: Record<string, unknown>): StorePriceChangeRecord =>
  Object.freeze({
    operationReference: String(row.operation),
    changeKind: String(row.change_kind) as StorePriceChangeKind,
    sellableReference: row.sellable === null ? null : String(row.sellable),
    previousAmountMinor: row.previous === null ? null : String(row.previous),
    amountMinor: row.amount === null ? null : String(row.amount),
    currencyCode: String(row.currency_code),
    priceBookReference: String(row.book),
    versionReference: String(row.version),
    assignmentReference: String(row.assignment),
    intentHash: String(row.intent_hash),
    actorReference: String(row.actor),
    changedAt: String(row.changed_at),
  });

/** The Store's record of this operation (a retry answers from it), or null. */
export async function findStorePriceChange(
  tx: Tx,
  scope: { readonly brandReference: string; readonly storeReference: string },
  operationReference: string,
): Promise<StorePriceChangeRecord | null> {
  const brand = parsePricingReference(scope.brandReference);
  const store = parsePricingReference(scope.storeReference);
  await storeScope(tx, brand, store);
  const row = (
    await tx.query(recordSql + " AND operation_id=$3", [
      brand,
      store,
      parsePricingReference(operationReference),
    ])
  ).rows[0];
  return row === undefined ? null : recordOf(row);
}

/** The Store's own price changes, newest first. */
export async function listStorePriceChanges(
  tx: Tx,
  scope: { readonly brandReference: string; readonly storeReference: string },
  limit = 20,
): Promise<readonly StorePriceChangeRecord[]> {
  const brand = parsePricingReference(scope.brandReference);
  const store = parsePricingReference(scope.storeReference);
  await storeScope(tx, brand, store);
  return (
    await tx.query(recordSql + " ORDER BY changed_at DESC,operation_id DESC LIMIT $3", [
      brand,
      store,
      Math.max(1, Math.min(100, limit)),
    ])
  ).rows.map(recordOf);
}

/**
 * Records the Store's new book (already written, Published and assigned to the Store at
 * `changedAt`) with a Store-scoped Audit. The database checks that it changes nothing but this
 * Store's own prices.
 */
export async function recordStorePriceChange(
  tx: Tx,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  input: StorePriceChangeRecord & {
    readonly sourcePriceBookReference: string;
    readonly sourceVersionReference: string;
    readonly auditReference: string;
  },
): Promise<StorePriceChangeRecord> {
  const brand = parsePricingReference(scope.brandReference);
  const store = parsePricingReference(scope.storeReference);
  if (input.changeKind !== "StorePrice" && input.changeKind !== "BrandListing")
    throw new Error("STORE_PRICE_CHANGE_INVALID");
  const values = [
    parsePricingReference(input.operationReference),
    parsePricingReference(scope.tenantReference),
    brand,
    store,
    input.changeKind,
    input.sellableReference === null ? null : parsePricingReference(input.sellableReference),
    minor(input.previousAmountMinor),
    minor(input.amountMinor),
    input.currencyCode,
    parsePricingReference(input.sourcePriceBookReference),
    parsePricingReference(input.sourceVersionReference),
    parsePricingReference(input.priceBookReference),
    parsePricingReference(input.versionReference),
    parsePricingReference(input.assignmentReference),
    parsePricingDigest(input.intentHash),
    parsePricingReference(input.actorReference),
    input.changedAt,
    parsePricingReference(input.auditReference),
  ];
  await storeScope(tx, brand, store);
  await tx.query(
    `INSERT INTO rms_pricing.store_price_change(operation_id,tenant_id,brand_id,store_id,change_kind,
      sellable_id,previous_amount_minor,amount_minor,currency_code,source_price_book_id,
      source_price_book_version_id,price_book_id,price_book_version_id,assignment_id,intent_hash,
      actor_id,changed_at,audit_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    values,
  );
  await appendAuditRecordInTransaction(tx, {
    auditId: input.auditReference,
    brandId: brand,
    storeId: store,
    actor: { type: "User", reference: input.actorReference },
    actionCode:
      input.changeKind === "StorePrice"
        ? "PRICING_STORE_PRICE_CHANGE"
        : "PRICING_STORE_PRICE_BRAND_LISTING",
    targetType: "PricingStorePriceBook",
    targetId: input.assignmentReference,
    correlationId: input.operationReference,
    reasonCode: "AUTHORIZED_OPERATION",
    occurredAt: input.changedAt,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "CONFIGURATION_AUDIT",
    retentionPolicyVersion: 1,
    afterSummary: {
      changeKind: input.changeKind,
      sellableReference: input.sellableReference,
      previousAmountMinor: input.previousAmountMinor,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      priceBookReference: input.priceBookReference,
      sourcePriceBookReference: input.sourcePriceBookReference,
    },
  } as AppendAuditRecordInput);
  const saved = await findStorePriceChange(tx, scope, input.operationReference);
  if (saved === null) throw new Error("STORE_PRICE_CHANGE_WRITE_UNCONFIRMED");
  return saved;
}
