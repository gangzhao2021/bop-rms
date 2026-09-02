import type { AppendAuditRecordInput } from "@bop/audit";
import type { InventoryInstant, InventoryReference } from "../domain/inventory-item.js";
import type { StockWasteAggregate } from "../domain/stock-waste.js";
import type { MovementStockScope, StockMovementFact } from "../domain/stock-movement.js";

export type StockWasteAction = "Validate" | "Submit" | "Approve" | "Reject" | "Cancel" | "Post";

export type StockWastePermission =
  | "inventory.waste.read"
  | "inventory.waste.record"
  | "inventory.waste.approve"
  | "inventory.waste.post";

export interface StockWasteCommand {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockWasteManagement";
  readonly permission: Exclude<StockWastePermission, "inventory.waste.read">;
  readonly operationReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly action: StockWasteAction;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StockWasteCommandRecord {
  readonly operationReference: InventoryReference;
  readonly intentHash: string;
  readonly action: StockWasteAction;
  readonly command: StockWasteCommand;
  readonly waste: StockWasteAggregate;
  readonly movement: StockMovementFact | null;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}

export interface StockWasteQuery {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockWasteRead";
  readonly permission: "inventory.waste.read";
  readonly stockScope: MovementStockScope;
  readonly wasteReference: InventoryReference;
}

export interface StockWasteProjection {
  readonly projectionName: "inventory_waste_wizard_v1";
  readonly projectionVersion: 1;
  readonly stockScope: MovementStockScope;
  readonly asOfUtc: InventoryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly waste: Omit<StockWasteAggregate, "evidenceReferences" | "costSummary"> & {
    readonly evidenceReferences: readonly InventoryReference[] | null;
    readonly costSummary: StockWasteAggregate["costSummary"] | null;
  };
}
