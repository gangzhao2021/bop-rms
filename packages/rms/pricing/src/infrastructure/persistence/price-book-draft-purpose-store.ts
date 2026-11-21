import { parsePricingReference } from "../../domain/money-tax-contract.js";

/**
 * WP-2423 menu-authoring-and-prices (M71): why a price book draft was started — the menu page's own
 * price draft that "List it" goes on with (MenuListing), or a price change started on the Prices
 * page (PriceChange) — and the Brand prices it was copied from (their digest), so a draft copied
 * before a later price change went live is never published over it. Append-only; written in the
 * draft's CreateDraft transaction.
 */
export interface PriceBookDraftPurposeTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export type PriceBookDraftPurposeKind = "MenuListing" | "PriceChange";
export interface PriceBookDraftPurpose {
  readonly priceBookReference: string;
  readonly purpose: PriceBookDraftPurposeKind;
  readonly sourcePriceBookReference: string | null;
  /** null: a draft started before purposes were recorded (what it started from is unknown). */
  readonly sourceBrandDigest: string | null;
  readonly actorReference: string;
  readonly recordedAt: string;
}
export class PriceBookDraftPurposeError extends Error {
  constructor(readonly code: "PRICE_BOOK_DRAFT_PURPOSE_CONFLICT") {
    super(code);
    this.name = "PriceBookDraftPurposeError";
  }
}
const conflict = (): never => {
  throw new PriceBookDraftPurposeError("PRICE_BOOK_DRAFT_PURPOSE_CONFLICT");
};
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const instant = (value: unknown): string => {
  const text = value instanceof Date ? value.toISOString() : value;
  return typeof text === "string" && instantPattern.test(text) ? text : conflict();
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  return d && "value" in d && Array.isArray(d.value) ? d.value : conflict();
}
const brandScope = (tx: PriceBookDraftPurposeTransaction, brand: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [brand]);

/**
 * Records why the draft was started, in its CreateDraft transaction. The same operation recording
 * the same purpose again is a replay; anything else conflicts.
 */
export async function recordPriceBookDraftPurpose(
  tx: PriceBookDraftPurposeTransaction,
  input: {
    readonly brandReference: string;
    readonly priceBookReference: string;
    readonly purpose: PriceBookDraftPurposeKind;
    readonly sourcePriceBookReference: string | null;
    readonly sourceBrandDigest: string;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly recordedAt: string;
  },
): Promise<"Created" | "AlreadyCommitted"> {
  if (input.purpose !== "MenuListing" && input.purpose !== "PriceChange") return conflict();
  if (!digestPattern.test(input.sourceBrandDigest)) return conflict();
  const value = {
    brand: String(parsePricingReference(input.brandReference)),
    book: String(parsePricingReference(input.priceBookReference)),
    source:
      input.sourcePriceBookReference === null
        ? null
        : String(parsePricingReference(input.sourcePriceBookReference)),
    operation: String(parsePricingReference(input.operationReference)),
    actor: String(parsePricingReference(input.actorReference)),
    at: instant(input.recordedAt),
  };
  await brandScope(tx, value.brand);
  const prior = rows(
    await tx.query(
      "SELECT operation_id::text operation,purpose FROM rms_pricing.price_book_draft_purpose WHERE price_book_id=$1 AND brand_id=$2",
      [value.book, value.brand],
    ),
  )[0];
  if (prior !== undefined) {
    if (prior.operation !== value.operation || prior.purpose !== input.purpose) return conflict();
    return "AlreadyCommitted";
  }
  await tx.query(
    "INSERT INTO rms_pricing.price_book_draft_purpose (price_book_id,brand_id,purpose,source_price_book_id,source_brand_digest,operation_id,actor_id,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      value.book,
      value.brand,
      input.purpose,
      value.source,
      input.sourceBrandDigest,
      value.operation,
      value.actor,
      value.at,
    ],
  );
  return "Created";
}

/** Why each of the Brand's price book drafts was started (books with no record are absent). */
export async function listPriceBookDraftPurposes(
  tx: PriceBookDraftPurposeTransaction,
  input: { readonly brandReference: string },
): Promise<readonly PriceBookDraftPurpose[]> {
  const brand = String(parsePricingReference(input.brandReference));
  await brandScope(tx, brand);
  return rows(
    await tx.query(
      "SELECT price_book_id::text book,purpose,source_price_book_id::text source,source_brand_digest digest,actor_id::text actor,recorded_at FROM rms_pricing.price_book_draft_purpose WHERE brand_id=$1 ORDER BY recorded_at,price_book_id",
      [brand],
    ),
  ).map((row) => {
    const purpose = row.purpose;
    if (purpose !== "MenuListing" && purpose !== "PriceChange") return conflict();
    const digest = row.digest;
    if (digest !== null && (typeof digest !== "string" || !digestPattern.test(digest)))
      return conflict();
    return {
      priceBookReference: String(row.book),
      purpose,
      sourcePriceBookReference: row.source === null ? null : String(row.source),
      sourceBrandDigest: digest,
      actorReference: String(row.actor),
      recordedAt: instant(row.recorded_at),
    };
  });
}
