import { appendAuditRecordInTransaction, sha256Hex, type AppendAuditRecordInput } from "@bop/audit";
import type { StockCountCommand, StockCountCommandRecord } from "../../contracts/stock-count.js";
import type { StockCountPorts } from "../../application/ports/stock-count-ports.js";
import type { InventoryItemAggregate, InventoryReference } from "../../domain/inventory-item.js";
import {
  markStockCountPosted,
  StockCountError,
  type StockCountAggregate,
} from "../../domain/stock-count.js";
import { parseStockMovementFact, type StockMovementFact } from "../../domain/stock-movement.js";
import type { StorageLocation } from "../../domain/stock-place.js";
import {
  appendStockMovement,
  ensureStockAccount,
  type LedgerTransaction,
} from "./ledger-posting.js";
import { openingCountReferences } from "./opening-count-store.js";

/**
 * WP-2423 / DEC-INV-STOCK-COUNT: Store persistence for the Stock Count service. A count covers one
 * Storage Location; its snapshot lists every stock account there plus the Active stock-tracked items
 * without lots that have none yet (expected 0). Approved variances post CountAdjustment movements, and
 * posting is refused for lines whose account moved after their snapshot (recount after refreshing).
 * Caller owns the transaction and authorization.
 */
export interface StockCountScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
/** Posting refused because stock moved on these lines after their snapshot. */
export class StockCountStaleError extends StockCountError {
  constructor(readonly lineReferences: readonly string[]) {
    super("STOCK_COUNT_CONFLICT");
  }
}
const scopeSql =
  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)";
async function scoped(tx: LedgerTransaction, scope: StockCountScope) {
  await tx.query(scopeSql, [scope.tenantReference, scope.brandReference, scope.storeReference]);
}
const dependency = (): never => {
  throw new StockCountError("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
};

/** Current ledger lines of one Location (accounts, plus untracked-lot items without an account). */
export async function captureLocationStock(
  tx: LedgerTransaction,
  scope: StockCountScope,
  locationReference: string,
  nextReference: () => string,
) {
  await scoped(tx, scope);
  const accounts = (
    await tx.query(
      `SELECT a.item_id::text item,a.lot_id::text lot,a.unit_code,b.on_hand::text on_hand,b.ledger_version::int version
       FROM rms_inventory.stock_account a JOIN rms_inventory.stock_balance b
         ON b.tenant_id=a.tenant_id AND b.brand_id=a.brand_id AND b.store_id=a.store_id AND b.account_id=a.account_id
       WHERE a.tenant_id=$1 AND a.brand_id=$2 AND a.store_id=$3 AND a.location_id=$4
       ORDER BY a.item_id,a.lot_id NULLS FIRST LIMIT 500`,
      [scope.tenantReference, scope.brandReference, scope.storeReference, locationReference],
    )
  ).rows;
  const refs = await openingCountReferences(tx, scope, []);
  const location = refs.locations.get(locationReference);
  if (!location || location.lifecycle !== "Active") return dependency();
  const itemsWithAccount = new Set(accounts.map((row) => String(row.item)));
  const candidates = (
    await tx.query(
      `SELECT i.item_id::text item FROM rms_inventory.inventory_item i WHERE i.tenant_id=$1 AND i.brand_id=$2
       ORDER BY i.internal_code LIMIT 1000`,
      [scope.tenantReference, scope.brandReference],
    )
  ).rows.map((row) => String(row.item));
  const loaded = await openingCountReferences(tx, scope, candidates);
  const lines = accounts.map((row) => ({
    lineReference: nextReference(),
    itemReference: String(row.item),
    lotReference: row.lot === null ? null : String(row.lot),
    locationReference,
    unitCode: String(row.unit_code),
    expectedQuantity: String(row.on_hand),
    balanceVersion: Number(row.version),
  }));
  for (const item of loaded.items.values())
    if (
      !itemsWithAccount.has(item.itemReference) &&
      item.lifecycle === "Active" &&
      item.trackingPolicy.stockTrackingEnabled &&
      item.trackingPolicy.lotTrackingMode === "NoLot" &&
      lines.length < 500
    )
      lines.push({
        lineReference: nextReference(),
        itemReference: item.itemReference,
        lotReference: null,
        locationReference,
        unitCode: item.baseUnit.unitCode,
        expectedQuantity: "0",
        // A new account starts at ledger version 1.
        balanceVersion: 1,
      });
  await scoped(tx, scope);
  return lines;
}

async function loadCount(
  tx: LedgerTransaction,
  scope: StockCountScope,
  countReference: string,
): Promise<StockCountAggregate | null> {
  await scoped(tx, scope);
  const row = (
    await tx.query(
      `SELECT v.count_json FROM rms_inventory.stock_count c JOIN rms_inventory.stock_count_version v
         ON v.tenant_id=c.tenant_id AND v.brand_id=c.brand_id AND v.store_id=c.store_id AND v.count_id=c.count_id AND v.version=c.current_version
       WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.store_id=$3 AND c.count_id=$4`,
      [scope.tenantReference, scope.brandReference, scope.storeReference, countReference],
    )
  ).rows[0];
  return row ? (row.count_json as StockCountAggregate) : null;
}

async function writeVersion(
  tx: LedgerTransaction,
  scope: StockCountScope,
  record: StockCountCommandRecord,
) {
  const count = record.count;
  if (count.aggregateVersion === 1) {
    if (count.stockScope.scopeType !== "Location") return dependency();
    await tx.query(
      `INSERT INTO rms_inventory.stock_count (tenant_id,brand_id,store_id,count_id,location_id,current_version,created_at,created_by_actor_id)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        count.countReference,
        count.stockScope.scopeReference,
        count.createdAt,
        count.createdBy,
      ],
    );
  } else {
    const moved = await tx.query(
      `UPDATE rms_inventory.stock_count SET current_version=$5 WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3
         AND count_id=$4 AND current_version=$6 RETURNING 1`,
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        count.countReference,
        count.aggregateVersion,
        count.aggregateVersion - 1,
      ],
    );
    if (moved.rows.length !== 1) throw new StockCountError("STOCK_COUNT_CONFLICT");
  }
  await tx.query(
    `INSERT INTO rms_inventory.stock_count_version (tenant_id,brand_id,store_id,count_id,version,status,count_json,recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      count.countReference,
      count.aggregateVersion,
      count.status,
      JSON.stringify(count),
      count.updatedAt,
    ],
  );
  await tx.query(
    `INSERT INTO rms_inventory.stock_count_operation (tenant_id,brand_id,store_id,operation_id,count_id,version,action,intent_hash,record_json,audit_id,recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      record.operationReference,
      count.countReference,
      count.aggregateVersion,
      record.action,
      record.intentHash,
      JSON.stringify(record),
      record.audit.auditId,
      count.updatedAt,
    ],
  );
  await appendAuditRecordInTransaction(tx, record.audit);
}

export function createPostgresStockCountPorts(
  tx: LedgerTransaction,
  scope: StockCountScope,
  options: {
    readonly authorization: StockCountPorts["authorization"];
    readonly nextReference: () => string;
    readonly audit: StockCountPorts["audit"]["create"];
  },
): StockCountPorts {
  return {
    authorization: options.authorization,
    references: {
      generate: () => options.nextReference(),
      hashIntent: (value) => "sha256:" + sha256Hex(value),
      equals: (left, right) => left === right,
    },
    audit: { create: options.audit },
    projection: {
      // The Store pages read through listStockCounts/loadStockCount; the service projection is the
      // detail of one count at its Location.
      async query(query) {
        const count =
          query.countReference === null ? null : await loadCount(tx, scope, query.countReference);
        return {
          projectionName: "inventory_count_workbench_v1",
          projectionVersion: 1,
          stockScope: query.stockScope,
          asOfUtc: (count?.updatedAt ??
            new Date().toISOString()) as StockCountAggregate["updatedAt"],
          freshness: "Current",
          partial: false,
          counts: count ? [count] : [],
        };
      },
    },
    snapshot: {
      async capture(command: StockCountCommand) {
        const location =
          command.action === "Create"
            ? (command.payload.stockScope as { scopeType: string; scopeReference: string })
            : ((await loadCount(tx, scope, String(command.payload.countReference)))?.stockScope ??
              dependency());
        if (location.scopeType !== "Location") return dependency();
        return {
          snapshotReference: options.nextReference(),
          capturedAt: command.occurredAt,
          stockScope: { scopeType: "Location", scopeReference: location.scopeReference },
          lines: await captureLocationStock(
            tx,
            scope,
            location.scopeReference,
            options.nextReference,
          ),
        };
      },
    },
    repository: {
      async resolveOperation(operationReference: InventoryReference) {
        await scoped(tx, scope);
        const row = (
          await tx.query(
            "SELECT record_json FROM rms_inventory.stock_count_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
            [scope.tenantReference, scope.brandReference, scope.storeReference, operationReference],
          )
        ).rows[0];
        return row ? (row.record_json as StockCountCommandRecord) : null;
      },
      load: (countReference) => loadCount(tx, scope, countReference),
      async commit(record) {
        await scoped(tx, scope);
        await writeVersion(tx, scope, record);
        return record;
      },
    },
    posting: {
      async commit({ command, before, intentHash, audit }) {
        await scoped(tx, scope);
        const required = before.lines.filter((line) => line.variance !== "0");
        const refs = await openingCountReferences(
          tx,
          scope,
          required.map((line) => line.itemReference),
        );
        const stale: string[] = [];
        const prepared = [];
        for (const line of required) {
          const item = refs.items.get(line.itemReference) as InventoryItemAggregate | undefined;
          const location = refs.locations.get(line.locationReference) as
            StorageLocation | undefined;
          if (!item || !location) return dependency();
          const expiry =
            line.lotReference === null
              ? null
              : ((
                  await tx.query(
                    "SELECT expiry_date::text e FROM rms_inventory.stock_lot WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND lot_id=$4",
                    [
                      scope.tenantReference,
                      scope.brandReference,
                      scope.storeReference,
                      line.lotReference,
                    ],
                  )
                ).rows[0]?.e ?? null);
          const account = await ensureStockAccount(tx, scope, {
            item,
            location,
            lotReference: line.lotReference,
            expiryDate: expiry === null ? null : String(expiry),
            occurredAt: command.occurredAt,
            nextReference: options.nextReference,
            open: !String(line.variance).startsWith("-"),
          }).catch(() => null);
          if (account === null || account.ledgerVersion !== line.balanceVersion) {
            stale.push(line.lineReference);
            continue;
          }
          prepared.push({ line, item, location, account, expiry });
        }
        if (stale.length > 0) throw new StockCountStaleError(stale);
        const movements: StockMovementFact[] = [];
        const references = new Map<InventoryReference, InventoryReference>();
        for (const { line, item, location, account, expiry } of prepared) {
          const posted = await appendStockMovement(tx, scope, {
            account,
            item,
            location,
            lotReference: line.lotReference,
            expiryDate: expiry === null ? null : String(expiry),
            movementType: "CountAdjustment",
            delta: String(line.variance),
            businessSourceType: "STOCK_COUNT",
            businessSourceReference: before.countReference,
            reasonCode: String(line.varianceReasonCode),
            actorReference: command.actorReference,
            occurredAt: command.occurredAt,
            auditReference: audit.auditId,
            nextReference: options.nextReference,
          });
          const row = (
            await tx.query(
              "SELECT record_json FROM rms_inventory.stock_movement WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND movement_id=$4",
              [
                scope.tenantReference,
                scope.brandReference,
                scope.storeReference,
                posted.movementReference,
              ],
            )
          ).rows[0];
          movements.push(parseStockMovementFact(row?.record_json));
          references.set(line.lineReference, posted.movementReference as InventoryReference);
        }
        const count = markStockCountPosted(
          before,
          references,
          before.aggregateVersion,
          command.actorReference,
          command.occurredAt,
        );
        const record: StockCountCommandRecord = Object.freeze({
          operationReference: command.operationReference,
          intentHash,
          action: "Post",
          command,
          count,
          movements: Object.freeze(movements),
          audit: audit as AppendAuditRecordInput,
          outcome: "Applied",
        });
        await writeVersion(tx, scope, record);
        return record;
      },
    },
  };
}

export interface StockCountSummary {
  readonly countReference: string;
  readonly locationReference: string;
  readonly status: StockCountAggregate["status"];
  readonly countType: StockCountAggregate["countType"];
  readonly assigneeReference: string | null;
  readonly lineCount: number;
  readonly countedLines: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
}
/** The Store's counts, newest first (no expected quantities). */
export async function listStockCounts(
  tx: LedgerTransaction,
  scope: StockCountScope,
  options: { readonly before: string | null; readonly limit: number },
): Promise<{ readonly counts: readonly StockCountSummary[]; readonly hasMore: boolean }> {
  await scoped(tx, scope);
  const rows = (
    await tx.query(
      `SELECT v.count_json FROM rms_inventory.stock_count c JOIN rms_inventory.stock_count_version v
         ON v.tenant_id=c.tenant_id AND v.brand_id=c.brand_id AND v.store_id=c.store_id AND v.count_id=c.count_id AND v.version=c.current_version
       WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.store_id=$3 AND ($4::timestamptz IS NULL OR c.created_at<$4::timestamptz)
       ORDER BY c.created_at DESC LIMIT $5`,
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        options.before,
        options.limit + 1,
      ],
    )
  ).rows.map((row) => row.count_json as StockCountAggregate);
  return {
    counts: rows.slice(0, options.limit).map((count) => ({
      countReference: count.countReference,
      locationReference: count.stockScope.scopeReference,
      status: count.status,
      countType: count.countType,
      assigneeReference: count.assigneeReference,
      lineCount: count.lines.length,
      countedLines: count.lines.filter((line) => line.countedQuantity !== null).length,
      createdAt: count.createdAt,
      createdBy: count.createdBy,
      updatedAt: count.updatedAt,
    })),
    hasMore: rows.length > options.limit,
  };
}
/** The open (not Posted or Cancelled) count of a Location, if any. */
export async function openStockCountAt(
  tx: LedgerTransaction,
  scope: StockCountScope,
  locationReference: string,
): Promise<string | null> {
  await scoped(tx, scope);
  const row = (
    await tx.query(
      `SELECT c.count_id::text id FROM rms_inventory.stock_count c JOIN rms_inventory.stock_count_version v
         ON v.tenant_id=c.tenant_id AND v.brand_id=c.brand_id AND v.store_id=c.store_id AND v.count_id=c.count_id AND v.version=c.current_version
       WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.store_id=$3 AND c.location_id=$4 AND v.status NOT IN ('Posted','Cancelled') LIMIT 1`,
      [scope.tenantReference, scope.brandReference, scope.storeReference, locationReference],
    )
  ).rows[0];
  return row ? String(row.id) : null;
}
export { loadCount as loadStockCount };

/** Printed lot codes and expiry dates of the Store's lots, for count sheets. */
export async function stockLotLabels(
  tx: LedgerTransaction,
  scope: StockCountScope,
  lotReferences: readonly string[],
): Promise<ReadonlyMap<string, { readonly lotCode: string; readonly expiryDate: string | null }>> {
  if (lotReferences.length === 0) return new Map();
  await scoped(tx, scope);
  return new Map(
    (
      await tx.query(
        "SELECT lot_id::text lot,lot_code,expiry_date::text expiry FROM rms_inventory.stock_lot WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND lot_id=ANY($4::uuid[])",
        [scope.tenantReference, scope.brandReference, scope.storeReference, [...lotReferences]],
      )
    ).rows.map((row) => [
      String(row.lot),
      {
        lotCode: String(row.lot_code),
        expiryDate: row.expiry === null ? null : String(row.expiry),
      },
    ]),
  );
}
