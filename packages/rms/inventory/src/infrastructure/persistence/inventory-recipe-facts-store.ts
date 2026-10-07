import { parseInventoryItemSnapshot } from "../../domain/inventory-item-snapshot.js";

export interface InventoryRecipeFactsTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface InventoryRecipeIngredientFact {
  readonly itemReference: string;
  readonly internalCode: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly unitCode: string;
  readonly dimension: string;
  readonly ledgerPrecision: number;
  readonly active: boolean;
  readonly stockTracked: boolean;
  /** Latest configuration operation: the pin a Recipe requirement records for this Item. */
  readonly configurationOperationReference: string;
  /** Latest received or opening unit cost in the Store, CAD cents per base unit. */
  readonly latestUnitCostMinor: number | null;
}

/**
 * WP-2423 / DEC-RECIPE-AUTHORING: Inventory owner's facts a Recipe ingredient line needs — each Item's
 * current base unit and lifecycle, the configuration operation it pins, and the latest unit cost
 * posted in the Store (receipts and the opening count; voided receipt lines excluded). Caller authorizes and owns the transaction.
 */
export async function listInventoryRecipeIngredientFacts(
  tx: InventoryRecipeFactsTransaction,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
): Promise<readonly InventoryRecipeIngredientFact[]> {
  await tx.query(
    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
    [scope.tenantReference, scope.brandReference],
  );
  const items = (
    await tx.query(
      `SELECT v.snapshot_json snapshot,o.operation_id::text operation
       FROM rms_inventory.inventory_item i
       JOIN LATERAL (SELECT snapshot_json FROM rms_inventory.inventory_item_version x
         WHERE x.tenant_id=i.tenant_id AND x.brand_id=i.brand_id AND x.item_id=i.item_id ORDER BY x.version DESC LIMIT 1) v ON true
       JOIN LATERAL (SELECT operation_id FROM rms_inventory.inventory_item_operation y
         WHERE y.tenant_id=i.tenant_id AND y.brand_id=i.brand_id AND y.item_id=i.item_id ORDER BY y.version DESC LIMIT 1) o ON true
       WHERE i.tenant_id=$1 AND i.brand_id=$2 ORDER BY i.internal_code LIMIT 5000`,
      [scope.tenantReference, scope.brandReference],
    )
  ).rows;
  await tx.query("SELECT set_config('bop.store_id',$1,true)", [scope.storeReference]);
  const costs = new Map(
    (
      await tx.query(
        `SELECT DISTINCT ON (m.record_json->>'itemReference') m.record_json->>'itemReference' item,(m.record_json->>'unitCostMinor')::bigint cost
         FROM rms_inventory.stock_movement m
         WHERE m.tenant_id=$1 AND m.brand_id=$2 AND m.store_id=$3 AND m.movement_type IN ('Receive','OpeningBalance')
           AND jsonb_typeof(m.record_json->'unitCostMinor')='number'
           -- A voided receipt line (reversed by a Correction) does not set the cost.
           AND NOT EXISTS (SELECT 1 FROM rms_inventory.stock_movement c WHERE c.tenant_id=m.tenant_id AND c.brand_id=m.brand_id
             AND c.store_id=m.store_id AND c.movement_type='Correction'
             AND c.record_json->>'correctsMovementReference'=m.movement_id::text)
         ORDER BY m.record_json->>'itemReference',m.occurred_at DESC,m.movement_id DESC`,
        [scope.tenantReference, scope.brandReference, scope.storeReference],
      )
    ).rows.map((row) => [String(row.item), Number(row.cost)]),
  );
  return items.map((row) => {
    const item = parseInventoryItemSnapshot(row.snapshot);
    return Object.freeze({
      itemReference: item.itemReference,
      internalCode: item.internalCode,
      localizedNames: item.localizedNames,
      unitCode: item.baseUnit.unitCode,
      dimension: item.baseUnit.dimension,
      ledgerPrecision: item.baseUnit.ledgerPrecision,
      active: item.lifecycle === "Active",
      stockTracked: item.trackingPolicy.stockTrackingEnabled,
      configurationOperationReference: String(row.operation),
      latestUnitCostMinor: costs.get(item.itemReference) ?? null,
    });
  });
}
