import { appendAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  applyOpeningCountChange,
  OpeningCountError,
  validateOpeningCountLines,
  type OpeningCount,
  type OpeningCountChange,
} from "../../domain/opening-count.js";
import {
  parseInventoryReference,
  type InventoryItemAggregate,
} from "../../domain/inventory-item.js";
import type { StorageLocation } from "../../domain/stock-place.js";
import { createPostgresInventoryItemStore } from "./inventory-item-store.js";
import { createPostgresStockPlaceStore } from "./stock-place-store.js";
import {
  appendStockMovement,
  ensureStockAccount,
  ensureStockLot,
  LedgerPostingError,
} from "./ledger-posting.js";

/**
 * WP-2423 / DEC-INV-OPENING: Inventory owner persistence for the Store opening count. Runs inside
 * the caller's transaction (the caller authorizes and owns COMMIT). Posting is all-or-nothing.
 */
export interface OpeningCountTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface OpeningCountScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
const fail = (
  code: OpeningCountError["code"] = "OPENING_COUNT_CONFLICT",
  line: string | null = null,
): never => {
  throw new OpeningCountError(code, line);
};
const scoped = (tx: OpeningCountTransaction, scope: OpeningCountScope) =>
  tx.query(
    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
    [scope.tenantReference, scope.brandReference, scope.storeReference],
  );
const latestSql = `SELECT DISTINCT ON (count_id) snapshot_json AS snapshot FROM rms_inventory.opening_count_version
  WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3`;

export async function listOpeningCounts(
  tx: OpeningCountTransaction,
  scope: OpeningCountScope,
): Promise<{
  readonly counts: readonly OpeningCount[];
  readonly postedCountReference: string | null;
}> {
  await scoped(tx, scope);
  const counts = (
    await tx.query(latestSql + " ORDER BY count_id DESC, version DESC", [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
    ])
  ).rows.map((row) => row.snapshot as OpeningCount);
  const posted = (
    await tx.query(
      "SELECT count_id::text AS count FROM rms_inventory.opening_count_posting WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3",
      [scope.tenantReference, scope.brandReference, scope.storeReference],
    )
  ).rows[0];
  return { counts, postedCountReference: posted ? String(posted.count) : null };
}
export async function loadOpeningCount(
  tx: OpeningCountTransaction,
  scope: OpeningCountScope,
  countReference: string,
): Promise<OpeningCount | null> {
  await scoped(tx, scope);
  const row = (
    await tx.query(latestSql + " AND count_id=$4 ORDER BY count_id, version DESC", [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      countReference,
    ])
  ).rows[0];
  return row ? (row.snapshot as OpeningCount) : null;
}

/** Current catalog facts for the lines: latest item versions (Brand) and the Store's locations. */
export async function openingCountReferences(
  tx: OpeningCountTransaction,
  scope: OpeningCountScope,
  itemReferences: readonly string[],
): Promise<{
  readonly items: ReadonlyMap<string, InventoryItemAggregate>;
  readonly locations: ReadonlyMap<string, StorageLocation>;
}> {
  const runner = { run: <T>(work: (t: never) => Promise<T>) => work(tx as never) };
  const itemStore = createPostgresInventoryItemStore(runner, {
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
  });
  const items = new Map<string, InventoryItemAggregate>();
  for (const reference of new Set(itemReferences)) {
    const item = await itemStore.load(parseInventoryReference(reference));
    if (item) items.set(reference, item);
  }
  const places = await createPostgresStockPlaceStore(runner, scope).list();
  await scoped(tx, scope);
  return {
    items,
    locations: new Map(places.locations.map((location) => [location.locationReference, location])),
  };
}

interface CommitInput {
  readonly operationReference: string;
  readonly countReference: string;
  readonly change: OpeningCountChange;
  readonly actorReference: string;
  readonly occurredAt: string;
  readonly auditReference: string;
}
function intentOf(input: CommitInput, scope: OpeningCountScope) {
  return (
    "sha256:" +
    sha256Hex(canonicalizeRfc8785({ scope, change: input.change, actor: input.actorReference }))
  );
}
async function priorOperation(
  tx: OpeningCountTransaction,
  scope: OpeningCountScope,
  input: CommitInput,
): Promise<OpeningCount | null> {
  const row = (
    await tx.query(
      "SELECT intent_hash,snapshot_json FROM rms_inventory.opening_count_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
      [scope.tenantReference, scope.brandReference, scope.storeReference, input.operationReference],
    )
  ).rows[0];
  if (!row) return null;
  if (row.intent_hash !== intentOf(input, scope)) fail("OPENING_COUNT_IDEMPOTENCY_CONFLICT");
  return row.snapshot_json as OpeningCount;
}
async function insertVersion(
  tx: OpeningCountTransaction,
  scope: OpeningCountScope,
  input: CommitInput,
  next: OpeningCount,
) {
  if (next.version === 1)
    await tx.query(
      "INSERT INTO rms_inventory.opening_count (tenant_id,brand_id,store_id,count_id,created_at,created_by_actor_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        next.countReference,
        next.createdAt,
        next.createdBy,
      ],
    );
  await tx.query(
    `INSERT INTO rms_inventory.opening_count_version (tenant_id,brand_id,store_id,count_id,version,lifecycle,snapshot_json,
       operation_id,intent_hash,changed_by_actor_id,changed_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      next.countReference,
      next.version,
      next.lifecycle,
      JSON.stringify(next),
      input.operationReference,
      intentOf(input, scope),
      input.actorReference,
      input.occurredAt,
      input.auditReference,
    ],
  );
}
async function audit(
  tx: OpeningCountTransaction,
  scope: OpeningCountScope,
  input: CommitInput,
  next: OpeningCount,
  summary: Record<string, string | number | null>,
) {
  await appendAuditRecordInTransaction(tx, {
    auditId: input.auditReference,
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "User", reference: input.actorReference },
    actionCode: "INVENTORY_OPENING_COUNT_" + input.change.action.toUpperCase(),
    targetType: "OpeningCount",
    targetId: next.countReference,
    afterSummary: {
      version: next.version,
      lifecycle: next.lifecycle,
      lines: next.lines.length,
      ...summary,
    },
    reasonCode: "STORE_OPENING_COUNT",
    correlationId: input.operationReference,
    occurredAt: input.occurredAt,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_STANDARD",
    retentionPolicyVersion: 1,
  });
}

/** Create, save lines, submit, reopen or cancel. Posting goes through `postOpeningCount`. */
export async function commitOpeningCountChange(
  tx: OpeningCountTransaction,
  scope: OpeningCountScope,
  input: CommitInput,
): Promise<{ readonly status: "Applied" | "AlreadyApplied"; readonly count: OpeningCount }> {
  if (input.change.action === "Post") return fail("OPENING_COUNT_INVALID");
  await scoped(tx, scope);
  const prior = await priorOperation(tx, scope, input);
  if (prior) return { status: "AlreadyApplied", count: prior };
  if (input.change.action === "Create") {
    const posted = await tx.query(
      "SELECT 1 FROM rms_inventory.opening_count_posting WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3",
      [scope.tenantReference, scope.brandReference, scope.storeReference],
    );
    if (posted.rows.length > 0) fail("OPENING_COUNT_ALREADY_POSTED");
  }
  if (input.change.action === "Create" && input.change.countReference !== input.countReference)
    fail("OPENING_COUNT_INVALID");
  const current =
    input.change.action === "Create"
      ? null
      : await loadOpeningCount(tx, scope, input.countReference);
  const next = applyOpeningCountChange(current, input.change, {
    ...scope,
    actorReference: input.actorReference,
    occurredAt: input.occurredAt,
  });
  if (input.change.action === "SaveLines" || input.change.action === "Submit") {
    const refs = await openingCountReferences(
      tx,
      scope,
      next.lines.map((line) => line.itemReference),
    );
    validateOpeningCountLines(next.lines, refs.items, refs.locations);
  }
  await insertVersion(tx, scope, input, next);
  await audit(tx, scope, input, next, {});
  return { status: "Applied", count: next };
}
/**
 * Posts a Submitted count once per Store: registers lots, opens accounts in the items' current
 * versions and writes each line as the account's first (OpeningBalance) movement, all referencing
 * one posting audit record.
 */
export async function postOpeningCount(
  tx: OpeningCountTransaction,
  scope: OpeningCountScope,
  input: CommitInput & { readonly nextReference: () => string },
): Promise<{
  readonly status: "Applied" | "AlreadyApplied";
  readonly count: OpeningCount;
  readonly movements: number;
}> {
  if (input.change.action !== "Post") return fail("OPENING_COUNT_INVALID");
  await scoped(tx, scope);
  const prior = await priorOperation(tx, scope, input);
  if (prior) return { status: "AlreadyApplied", count: prior, movements: prior.lines.length };
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "OpeningCountPosting:" + scope.storeReference,
  ]);
  const posted = await tx.query(
    "SELECT 1 FROM rms_inventory.opening_count_posting WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3",
    [scope.tenantReference, scope.brandReference, scope.storeReference],
  );
  if (posted.rows.length > 0) fail("OPENING_COUNT_ALREADY_POSTED");
  const current = await loadOpeningCount(tx, scope, input.countReference);
  const next = applyOpeningCountChange(current, input.change, {
    ...scope,
    actorReference: input.actorReference,
    occurredAt: input.occurredAt,
  });
  const refs = await openingCountReferences(
    tx,
    scope,
    next.lines.map((line) => line.itemReference),
  );
  validateOpeningCountLines(next.lines, refs.items, refs.locations);
  for (const line of next.lines) {
    const item = refs.items.get(line.itemReference) as InventoryItemAggregate,
      location = refs.locations.get(line.locationReference) as StorageLocation;
    let lot: string | null = null;
    try {
      if (line.lotCode !== null)
        lot = await ensureStockLot(tx, scope, {
          itemReference: item.itemReference,
          lotCode: line.lotCode,
          expiryDate: line.expiryDate,
          sourceType: "OpeningCount",
          sourceReference: next.countReference,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
          nextReference: input.nextReference,
        });
    } catch (error) {
      if (error instanceof LedgerPostingError)
        fail("OPENING_COUNT_LINE_INVALID", line.lineReference);
      throw error;
    }
    const account = await ensureStockAccount(tx, scope, {
      item,
      location,
      lotReference: lot,
      expiryDate: line.expiryDate,
      occurredAt: input.occurredAt,
      nextReference: input.nextReference,
      open: true,
    });
    // An account that already moved stock cannot receive an opening balance.
    if (account.ledgerVersion !== 1) fail("OPENING_COUNT_STOCK_EXISTS", line.lineReference);
    await appendStockMovement(tx, scope, {
      account,
      item,
      location,
      lotReference: lot,
      expiryDate: line.expiryDate,
      movementType: "OpeningBalance",
      delta: line.quantity,
      businessSourceType: "OpeningCount",
      businessSourceReference: next.countReference,
      reasonCode: "STORE_OPENING_COUNT",
      actorReference: input.actorReference,
      occurredAt: input.occurredAt,
      auditReference: input.auditReference,
      extra: { unitCostMinor: line.unitCostMinor },
      nextReference: input.nextReference,
    });
  }
  await tx.query(
    `INSERT INTO rms_inventory.opening_count_posting (tenant_id,brand_id,store_id,count_id,movement_count,posted_by_actor_id,posted_at,audit_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      next.countReference,
      next.lines.length,
      input.actorReference,
      input.occurredAt,
      input.auditReference,
    ],
  );
  await insertVersion(tx, scope, input, next);
  await audit(tx, scope, input, next, { movements: next.lines.length });
  return { status: "Applied", count: next, movements: next.lines.length };
}
