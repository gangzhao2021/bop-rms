import type { AppendAuditRecordInput } from "@bop/audit";
import type { InventoryInstant, InventoryReference } from "../domain/inventory-item.js";
import type { StockAdjustmentAggregate } from "../domain/stock-adjustment.js";
import type { MovementStockScope, StockMovementFact } from "../domain/stock-movement.js";

export type StockAdjustmentAction =
  "Validate" | "Submit" | "Approve" | "Reject" | "Cancel" | "Post";

export type StockAdjustmentPermission =
  | "inventory.adjustment.read"
  | "inventory.adjustment.execute"
  | "inventory.adjustment.approve"
  | "inventory.adjustment.post";

export interface StockAdjustmentCommand {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockAdjustmentManagement";
  readonly permission: Exclude<StockAdjustmentPermission, "inventory.adjustment.read">;
  readonly operationReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly action: StockAdjustmentAction;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StockAdjustmentCommandRecord {
  readonly operationReference: InventoryReference;
  readonly intentHash: string;
  readonly action: StockAdjustmentAction;
  readonly command: StockAdjustmentCommand;
  readonly adjustment: StockAdjustmentAggregate;
  readonly movement: StockMovementFact | null;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}

export interface StockAdjustmentQuery {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockAdjustmentRead";
  readonly permission: "inventory.adjustment.read";
  readonly stockScope: MovementStockScope;
  readonly adjustmentReference: InventoryReference;
}

export interface StockAdjustmentProjection {
  readonly projectionName: "inventory_adjustment_wizard_v1";
  readonly projectionVersion: 1;
  readonly stockScope: MovementStockScope;
  readonly asOfUtc: InventoryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly adjustment: Omit<StockAdjustmentAggregate, "evidenceReferences"> & {
    readonly evidenceReferences: readonly InventoryReference[] | null;
  };
}
