import { appendAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { InventoryItemAggregate } from "../../domain/inventory-item.js";
import type { StorageLocation } from "../../domain/stock-place.js";
import {
  StoreWasteError,
  storeWasteReviewThresholdMinor,
  storeWasteValueMinor,
  type PostedStoreWasteLine,
  type StoreWasteLine,
  type StoreWasteRecord,
} from "../../domain/store-waste.js";
import { latestStoreUnitCosts } from "./inventory-recipe-facts-store.js";
import {
  addDecimal,
  appendStockMovement,
  ensureStockAccount,
  LedgerPostingError,
  type LedgerTransaction,
} from "./ledger-posting.js";
import { openingCountReferences } from "./opening-count-store.js";

/**
 * WP-2423 / DEC-INV-WASTE: Store waste records and their reviews in the caller's transaction. Each line
 * leaves stock through a Waste movement that never touches reserved stock; a review accepts the record
 * or voids it with Correction movements. Caller owns authorization.
 */
export interface StoreWasteScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface StoreWasteView extends StoreWasteRecord {
  readonly review: {
    readonly decision: "Accepted" | "Voided";
    readonly reasonCode: string;
    readonly reviewedBy: string;
    readonly reviewedAt: string;
  } | null;
}
const fail = (code: StoreWasteError["code"], line: string | null = null): never => {
  throw new StoreWasteError(code, line);
};
const scopeSql =
  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)";
async function scoped(tx: LedgerTransaction, scope: StoreWasteScope) {
  await tx.query(scopeSql, [scope.tenantReference, scope.brandReference, scope.storeReference]);
}
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const selectSql = `SELECT w.record_json,r.decision,r.reason_code,r.reviewed_by_actor_id::text reviewed_by,r.reviewed_at
 FROM rms_inventory.store_waste w LEFT JOIN rms_inventory.store_waste_review r
   ON r.tenant_id=w.tenant_id AND r.brand_id=w.brand_id AND r.store_id=w.store_id AND r.waste_id=w.waste_id
 WHERE w.tenant_id=$1 AND w.brand_id=$2 AND w.store_id=$3`;
const view = (row: Record<string, unknown>): StoreWasteView => ({
  ...(({ intent: _intent, ...record }: StoreWasteRecord & { readonly intent?: string }) => {
    void _intent;
    return record;
  })(row.record_json as StoreWasteRecord),
  review:
    row.decision === null || row.decision === undefined
      ? null
      : {
          decision: row.decision as "Accepted" | "Voided",
          reasonCode: String(row.reason_code),
          reviewedBy: String(row.reviewed_by),
          reviewedAt: iso(row.reviewed_at),
        },
});

export async function listStoreWaste(
  tx: LedgerTransaction,
  scope: StoreWasteScope,
  options: {
    readonly before: string | null;
    readonly limit: number;
    readonly needsReviewOnly: boolean;
  },
): Promise<{ readonly records: readonly StoreWasteView[]; readonly hasMore: boolean }> {
  await scoped(tx, scope);
  const rows = (
    await tx.query(
      selectSql +
        ` AND ($4::timestamptz IS NULL OR w.recorded_at<$4::timestamptz)
          AND (NOT $5::boolean OR (w.needs_review AND r.waste_id IS NULL))
        ORDER BY w.recorded_at DESC,w.waste_id DESC LIMIT $6`,
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        options.before,
        options.needsReviewOnly,
        options.limit + 1,
      ],
    )
  ).rows;
  return { records: rows.slice(0, options.limit).map(view), hasMore: rows.length > options.limit };
}
export async function loadStoreWaste(
  tx: LedgerTransaction,
  scope: StoreWasteScope,
  wasteReference: string,
): Promise<StoreWasteView | null> {
  await scoped(tx, scope);
  const row = (
    await tx.query(selectSql + " AND w.waste_id=$4", [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      wasteReference,
    ])
  ).rows[0];
  return row ? view(row) : null;
}

/** Stock (by location and lot) a waste line can take: available = on hand − reserved. */
export async function listWasteableStock(
  tx: LedgerTransaction,
  scope: StoreWasteScope,
): Promise<
  readonly {
    readonly itemReference: string;
    readonly locationReference: string;
    readonly lotReference: string | null;
    readonly lotCode: string | null;
    readonly expiryDate: string | null;
    readonly unitCode: string;
    readonly available: string;
  }[]
> {
  await scoped(tx, scope);
  return (
    await tx.query(
      `SELECT a.item_id::text item,a.location_id::text location,a.lot_id::text lot,l.lot_code,a.expiry_date::text expiry,a.unit_code,
         (b.on_hand-b.reserved)::text available
       FROM rms_inventory.stock_account a JOIN rms_inventory.stock_balance b
         ON b.tenant_id=a.tenant_id AND b.brand_id=a.brand_id AND b.store_id=a.store_id AND b.account_id=a.account_id
       LEFT JOIN rms_inventory.stock_lot l ON l.tenant_id=a.tenant_id AND l.brand_id=a.brand_id AND l.store_id=a.store_id AND l.lot_id=a.lot_id
       WHERE a.tenant_id=$1 AND a.brand_id=$2 AND a.store_id=$3 AND b.on_hand-b.reserved>0
       ORDER BY a.item_id,a.location_id,a.expiry_date NULLS LAST LIMIT 2000`,
      [scope.tenantReference, scope.brandReference, scope.storeReference],
    )
  ).rows.map((row) => ({
    itemReference: String(row.item),
    locationReference: String(row.location),
    lotReference: row.lot === null ? null : String(row.lot),
    lotCode: row.lot_code === null ? null : String(row.lot_code),
    expiryDate: row.expiry === null ? null : String(row.expiry),
    unitCode: String(row.unit_code),
    available: String(row.available),
  }));
}

const isNegative = (value: string) => value.startsWith("-");

export async function postStoreWaste(
  tx: LedgerTransaction,
  scope: StoreWasteScope,
  input: {
    readonly operationReference: string;
    readonly wasteReference: string;
    readonly lines: readonly StoreWasteLine[];
    readonly actorReference: string;
    readonly occurredAt: string;
    readonly auditReference: string;
    readonly nextReference: () => string;
  },
): Promise<{ readonly status: "Applied" | "AlreadyApplied"; readonly record: StoreWasteView }> {
  await scoped(tx, scope);
  const intent =
    "sha256:" +
    sha256Hex(
      canonicalizeRfc8785({
        waste: input.wasteReference,
        lines: input.lines,
        actor: input.actorReference,
      }),
    );
  const prior = (
    await tx.query(
      "SELECT waste_id::text waste,record_json->>'intent' intent FROM rms_inventory.store_waste WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
      [scope.tenantReference, scope.brandReference, scope.storeReference, input.operationReference],
    )
  ).rows[0];
  if (prior) {
    const record = await loadStoreWaste(tx, scope, String(prior.waste));
    if (record === null || prior.intent !== intent) fail("STORE_WASTE_IDEMPOTENCY_CONFLICT");
    return { status: "AlreadyApplied", record: record as StoreWasteView };
  }
  const refs = await openingCountReferences(
    tx,
    scope,
    input.lines.map((line) => line.itemReference),
  );
  const costs = await latestStoreUnitCosts(tx, scope);
  await scoped(tx, scope);
  const posted: PostedStoreWasteLine[] = [];
  for (const line of input.lines) {
    const item = refs.items.get(line.itemReference) as InventoryItemAggregate | undefined;
    const location = refs.locations.get(line.locationReference) as StorageLocation | undefined;
    const precision = item?.baseUnit.ledgerPrecision ?? 0;
    if (
      !item ||
      !item.trackingPolicy.stockTrackingEnabled ||
      !location ||
      (line.quantity.split(".")[1] ?? "").length > precision ||
      (item.trackingPolicy.lotTrackingMode === "NoLot") !== (line.lotReference === null)
    )
      fail("STORE_WASTE_LINE_INVALID", line.lineReference);
    const lot =
      line.lotReference === null
        ? null
        : ((
            await tx.query(
              "SELECT expiry_date::text e,item_id::text item FROM rms_inventory.stock_lot WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND lot_id=$4",
              [
                scope.tenantReference,
                scope.brandReference,
                scope.storeReference,
                line.lotReference,
              ],
            )
          ).rows[0] ?? fail("STORE_WASTE_LINE_INVALID", line.lineReference));
    if (lot !== null && lot.item !== item?.itemReference)
      fail("STORE_WASTE_LINE_INVALID", line.lineReference);
    const expiry = lot === null || lot.e === null ? null : String(lot.e);
    let account;
    try {
      account = await ensureStockAccount(tx, scope, {
        item: item as InventoryItemAggregate,
        location: location as StorageLocation,
        lotReference: line.lotReference,
        expiryDate: expiry,
        occurredAt: input.occurredAt,
        nextReference: input.nextReference,
        open: false,
      });
    } catch (error) {
      if (error instanceof LedgerPostingError)
        return fail("STORE_WASTE_NOT_ENOUGH_STOCK", line.lineReference);
      throw error;
    }
    const available = addDecimal(account.onHand, "-" + account.reserved);
    if (isNegative(addDecimal(available, "-" + line.quantity)))
      fail("STORE_WASTE_NOT_ENOUGH_STOCK", line.lineReference);
    const movement = await appendStockMovement(tx, scope, {
      account,
      item: item as InventoryItemAggregate,
      location: location as StorageLocation,
      lotReference: line.lotReference,
      expiryDate: expiry,
      movementType: "Waste",
      delta: "-" + line.quantity,
      businessSourceType: "STORE_WASTE",
      businessSourceReference: input.wasteReference,
      reasonCode: line.reasonCode,
      actorReference: input.actorReference,
      occurredAt: input.occurredAt,
      auditReference: input.auditReference,
      nextReference: input.nextReference,
    });
    const unitCostMinor = costs.get(line.itemReference) ?? null;
    posted.push(
      Object.freeze({
        ...line,
        unitCode: (item as InventoryItemAggregate).baseUnit.unitCode,
        unitCostMinor,
        valueMinor: unitCostMinor === null ? 0 : storeWasteValueMinor(line.quantity, unitCostMinor),
        movementReference: movement.movementReference,
      }),
    );
  }
  const valueMinor = posted.reduce((sum, line) => sum + line.valueMinor, 0);
  const costUnknown = posted.some((line) => line.unitCostMinor === null);
  const record: StoreWasteRecord & { readonly intent: string } = {
    schemaVersion: 1,
    wasteReference: input.wasteReference,
    ...scope,
    lines: Object.freeze(posted),
    valueMinor,
    costUnknown,
    needsReview: costUnknown || valueMinor >= storeWasteReviewThresholdMinor,
    recordedBy: input.actorReference,
    recordedAt: input.occurredAt,
    intent,
  };
  await tx.query(
    `INSERT INTO rms_inventory.store_waste (tenant_id,brand_id,store_id,waste_id,operation_id,record_json,value_minor,needs_review,
       recorded_by_actor_id,recorded_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      input.wasteReference,
      input.operationReference,
      JSON.stringify(record),
      valueMinor,
      record.needsReview,
      input.actorReference,
      input.occurredAt,
      input.auditReference,
    ],
  );
  await appendAuditRecordInTransaction(tx, {
    auditId: input.auditReference,
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "User", reference: input.actorReference },
    actionCode: "INVENTORY_WASTE_RECORDED",
    targetType: "StoreWaste",
    targetId: input.wasteReference,
    afterSummary: {
      lines: posted.length,
      valueMinor,
      needsReview: record.needsReview,
    },
    reasonCode: "STORE_WASTE",
    correlationId: input.operationReference,
    occurredAt: input.occurredAt,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_STANDARD",
    retentionPolicyVersion: 1,
  });
  return {
    status: "Applied",
    record: (await loadStoreWaste(tx, scope, input.wasteReference)) as StoreWasteView,
  };
}

/** Accepts a waste record, or voids it by putting every line back through a Correction movement. */
export async function reviewStoreWaste(
  tx: LedgerTransaction,
  scope: StoreWasteScope,
  input: {
    readonly operationReference: string;
    readonly wasteReference: string;
    readonly decision: "Accepted" | "Voided";
    readonly reasonCode: string;
    readonly actorReference: string;
    readonly occurredAt: string;
    readonly auditReference: string;
    readonly nextReference: () => string;
  },
): Promise<{ readonly status: "Applied" | "AlreadyApplied"; readonly record: StoreWasteView }> {
  await scoped(tx, scope);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "rms_inventory.store_waste_review:" + input.wasteReference,
  ]);
  const record = await loadStoreWaste(tx, scope, input.wasteReference);
  if (record === null) return fail("STORE_WASTE_NOT_FOUND");
  if (record.review !== null) {
    const same = (
      await tx.query(
        "SELECT operation_id::text op FROM rms_inventory.store_waste_review WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND waste_id=$4",
        [scope.tenantReference, scope.brandReference, scope.storeReference, input.wasteReference],
      )
    ).rows[0];
    if (same?.op === input.operationReference) return { status: "AlreadyApplied", record };
    return fail("STORE_WASTE_ALREADY_REVIEWED");
  }
  if (record.recordedBy === input.actorReference)
    return fail("STORE_WASTE_REVIEWER_NOT_INDEPENDENT");
  if (input.decision === "Voided") {
    const refs = await openingCountReferences(
      tx,
      scope,
      record.lines.map((line) => line.itemReference),
    );
    await scoped(tx, scope);
    for (const line of record.lines) {
      const item = refs.items.get(line.itemReference) as InventoryItemAggregate,
        location = refs.locations.get(line.locationReference) as StorageLocation;
      if (!item || !location) return fail("STORE_WASTE_LINE_INVALID", line.lineReference);
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
        occurredAt: input.occurredAt,
        nextReference: input.nextReference,
        open: false,
      });
      await appendStockMovement(tx, scope, {
        account,
        item,
        location,
        lotReference: line.lotReference,
        expiryDate: expiry === null ? null : String(expiry),
        movementType: "Correction",
        delta: line.quantity,
        businessSourceType: "STORE_WASTE_VOID",
        businessSourceReference: input.wasteReference,
        reasonCode: input.reasonCode,
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
        auditReference: input.auditReference,
        correctsMovementReference: line.movementReference,
        nextReference: input.nextReference,
      });
    }
  }
  await tx.query(
    `INSERT INTO rms_inventory.store_waste_review (tenant_id,brand_id,store_id,waste_id,operation_id,decision,reason_code,
       reviewed_by_actor_id,recorded_by_actor_id,reviewed_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      input.wasteReference,
      input.operationReference,
      input.decision,
      input.reasonCode,
      input.actorReference,
      record.recordedBy,
      input.occurredAt,
      input.auditReference,
    ],
  );
  await appendAuditRecordInTransaction(tx, {
    auditId: input.auditReference,
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "User", reference: input.actorReference },
    actionCode: input.decision === "Voided" ? "INVENTORY_WASTE_VOIDED" : "INVENTORY_WASTE_ACCEPTED",
    targetType: "StoreWaste",
    targetId: input.wasteReference,
    afterSummary: { valueMinor: record.valueMinor, lines: record.lines.length },
    reasonCode: input.reasonCode,
    correlationId: input.operationReference,
    occurredAt: input.occurredAt,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_STANDARD",
    retentionPolicyVersion: 1,
  });
  return {
    status: "Applied",
    record: (await loadStoreWaste(tx, scope, input.wasteReference)) as StoreWasteView,
  };
}
