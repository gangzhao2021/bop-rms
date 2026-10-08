import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { parsePricingReference } from "../../domain/money-tax-contract.js";

/**
 * WP-2423 / DEC-PRICE-STORE-ASSIGNMENT: the Brand price book a Store charges. Assigning a Published price
 * book version starts at once and ends the Store's current assignment (superseded). History is
 * append-only. Caller authorizes and owns the transaction; reads and writes run in the Store scope.
 */
export type StorePriceBookErrorCode =
  | "STORE_PRICE_BOOK_NOT_FOUND"
  | "STORE_PRICE_BOOK_NOT_PUBLISHED"
  | "STORE_PRICE_BOOK_ALREADY_ASSIGNED"
  | "STORE_PRICE_BOOK_IDEMPOTENCY_CONFLICT";
export class StorePriceBookError extends Error {
  constructor(readonly code: StorePriceBookErrorCode) {
    super(code);
    this.name = "StorePriceBookError";
  }
}
const fail = (code: StorePriceBookErrorCode): never => {
  throw new StorePriceBookError(code);
};
interface Tx {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface StorePriceBookScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface StorePriceBookAssignment {
  readonly assignmentReference: string;
  readonly priceBookReference: string;
  readonly versionReference: string;
  readonly stableCode: string;
  readonly effectiveFrom: string;
  readonly endedAt: string | null;
  readonly assignedBy: string;
}
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const storeScope = (tx: Tx, brand: string, store: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
const assignmentSql = `SELECT a.assignment_id::text assignment,a.price_book_id::text book,
  a.price_book_version_id::text version,b.stable_code,${iso("a.effective_from")} effective_from,
  ${iso("e.ended_at")} ended_at,a.actor_id::text actor
 FROM rms_pricing.store_price_book_assignment a
 JOIN rms_pricing.price_book b ON b.price_book_id=a.price_book_id AND b.brand_id=a.brand_id
 LEFT JOIN rms_pricing.store_price_book_assignment_end e ON e.assignment_id=a.assignment_id
 WHERE a.brand_id=$1 AND a.store_id=$2`;
const assignmentOf = (row: Record<string, unknown>): StorePriceBookAssignment =>
  Object.freeze({
    assignmentReference: String(row.assignment),
    priceBookReference: String(row.book),
    versionReference: String(row.version),
    stableCode: String(row.stable_code),
    effectiveFrom: String(row.effective_from),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    assignedBy: String(row.actor),
  });

/** The Store's open assignment, or null when the Store has no price book. */
export async function currentStorePriceBook(
  tx: Tx,
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<StorePriceBookAssignment | null> {
  const brand = parsePricingReference(scope.brandReference);
  const store = parsePricingReference(scope.storeReference);
  await storeScope(tx, brand, store);
  const rows = (
    await tx.query(assignmentSql + " AND e.assignment_id IS NULL ORDER BY a.effective_from DESC", [
      brand,
      store,
    ])
  ).rows;
  return rows[0] === undefined ? null : assignmentOf(rows[0]);
}

/** The Store's assignments, newest first. */
export async function listStorePriceBookAssignments(
  tx: Tx,
  scope: { readonly brandReference: string; readonly storeReference: string },
  limit = 20,
): Promise<readonly StorePriceBookAssignment[]> {
  const brand = parsePricingReference(scope.brandReference);
  const store = parsePricingReference(scope.storeReference);
  await storeScope(tx, brand, store);
  return (
    await tx.query(
      assignmentSql + " ORDER BY a.effective_from DESC,a.assignment_id DESC LIMIT $3",
      [brand, store, Math.max(1, Math.min(100, limit))],
    )
  ).rows.map(assignmentOf);
}

export interface BrandPriceBookSummary {
  readonly priceBookReference: string;
  readonly stableCode: string;
  readonly lifecycle: string;
  readonly aggregateVersion: number;
  readonly versionReference: string;
  readonly entries: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/** The Brand's price books with their current version. */
export async function listBrandPriceBooks(
  tx: Tx,
  scope: { readonly brandReference: string },
): Promise<readonly BrandPriceBookSummary[]> {
  const brand = parsePricingReference(scope.brandReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
    brand,
  ]);
  return (
    await tx.query(
      `SELECT b.price_book_id::text book,b.stable_code,v.lifecycle,b.aggregate_version,v.price_book_version_id::text version,
        (SELECT count(*) FROM rms_pricing.price_entry e WHERE e.brand_id=b.brand_id AND e.price_book_id=b.price_book_id
          AND e.price_book_version_id=v.price_book_version_id)::int entries,
        ${iso("b.created_at")} created_at,${iso("b.updated_at")} updated_at
       FROM rms_pricing.price_book b JOIN rms_pricing.price_book_version v
        ON v.price_book_version_id=b.current_version_id AND v.price_book_id=b.price_book_id AND v.brand_id=b.brand_id
       WHERE b.brand_id=$1 ORDER BY v.lifecycle='Archived',b.updated_at DESC LIMIT 200`,
      [brand],
    )
  ).rows.map((row) =>
    Object.freeze({
      priceBookReference: String(row.book),
      stableCode: String(row.stable_code),
      lifecycle: String(row.lifecycle),
      aggregateVersion: Number(row.aggregate_version),
      versionReference: String(row.version),
      entries: Number(row.entries),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }),
  );
}

/**
 * Assigns the price book's current Published version to the Store from `at` and ends the open
 * assignment. Replaying the same operation returns its assignment. The caller checks that the
 * book prices everything the Store sells before calling.
 */
export async function assignStorePriceBook(
  tx: Tx,
  scope: StorePriceBookScope,
  input: {
    readonly operationReference: string;
    readonly priceBookReference: string;
    readonly actorReference: string;
    readonly at: string;
    readonly auditReference: string;
    readonly assignmentReference: string;
  },
): Promise<{
  readonly status: "Applied" | "AlreadyApplied";
  readonly assignment: StorePriceBookAssignment;
}> {
  const brand = parsePricingReference(scope.brandReference);
  const store = parsePricingReference(scope.storeReference);
  const operation = parsePricingReference(input.operationReference);
  const book = parsePricingReference(input.priceBookReference);
  const intent = "sha256:" + sha256Hex(canonicalizeRfc8785({ store, priceBookReference: book }));
  await storeScope(tx, brand, store);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "StorePriceBook:" + brand + ":" + store,
  ]);
  const prior = (
    await tx.query(assignmentSql + " AND a.operation_id=$3", [brand, store, operation])
  ).rows[0];
  if (prior !== undefined) {
    const hash = (
      await tx.query(
        "SELECT intent_hash FROM rms_pricing.store_price_book_assignment WHERE operation_id=$1",
        [operation],
      )
    ).rows[0]?.intent_hash;
    if (hash !== intent) fail("STORE_PRICE_BOOK_IDEMPOTENCY_CONFLICT");
    return { status: "AlreadyApplied", assignment: assignmentOf(prior) };
  }
  const version = (
    await tx.query(
      `SELECT v.price_book_version_id::text version,v.lifecycle,b.stable_code
       FROM rms_pricing.price_book b JOIN rms_pricing.price_book_version v
        ON v.price_book_version_id=b.current_version_id AND v.price_book_id=b.price_book_id AND v.brand_id=b.brand_id
       WHERE b.brand_id=$1 AND b.price_book_id=$2`,
      [brand, book],
    )
  ).rows[0];
  if (version === undefined) return fail("STORE_PRICE_BOOK_NOT_FOUND");
  if (version.lifecycle !== "Published") return fail("STORE_PRICE_BOOK_NOT_PUBLISHED");
  const current = await currentStorePriceBook(tx, { brandReference: brand, storeReference: store });
  if (current !== null && current.versionReference === version.version)
    return fail("STORE_PRICE_BOOK_ALREADY_ASSIGNED");
  const assignment = parsePricingReference(input.assignmentReference);
  await tx.query(
    `INSERT INTO rms_pricing.store_price_book_assignment(assignment_id,tenant_id,brand_id,store_id,price_book_id,
      price_book_version_id,effective_from,operation_id,intent_hash,actor_id,audit_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      assignment,
      scope.tenantReference,
      brand,
      store,
      book,
      version.version,
      input.at,
      operation,
      intent,
      input.actorReference,
      input.auditReference,
    ],
  );
  if (current !== null)
    await tx.query(
      `INSERT INTO rms_pricing.store_price_book_assignment_end(assignment_id,brand_id,store_id,ended_at,reason_code,
        superseded_by_assignment_id) VALUES($1,$2,$3,$4,'SUPERSEDED',$5)`,
      [current.assignmentReference, brand, store, input.at, assignment],
    );
  const audit: AppendAuditRecordInput = {
    auditId: input.auditReference,
    brandId: brand,
    storeId: store,
    actor: { type: "User", reference: input.actorReference },
    actionCode: "PRICING_STORE_PRICE_BOOK_ASSIGN",
    targetType: "PricingStorePriceBook",
    targetId: assignment,
    correlationId: operation,
    reasonCode: "AUTHORIZED_OPERATION",
    occurredAt: input.at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "CONFIGURATION_AUDIT",
    retentionPolicyVersion: 1,
    afterSummary: {
      priceBookReference: book,
      versionReference: String(version.version),
      supersededAssignmentReference: current?.assignmentReference ?? null,
    },
  } as AppendAuditRecordInput;
  await appendAuditRecordInTransaction(tx, audit);
  const saved = await currentStorePriceBook(tx, { brandReference: brand, storeReference: store });
  if (saved === null || saved.assignmentReference !== assignment)
    throw new Error("STORE_PRICE_BOOK_WRITE_UNCONFIRMED");
  return { status: "Applied", assignment: saved };
}
