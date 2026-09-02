import type { AppendAuditRecordInput } from "@bop/audit";
import type { InventoryInstant, InventoryReference } from "../domain/inventory-item.js";
import type { StockTransferAggregate } from "../domain/stock-transfer.js";
import type { MovementStockScope, StockMovementFact } from "../domain/stock-movement.js";

export type StockTransferAction =
  | "Create"
  | "Revise"
  | "Submit"
  | "Approve"
  | "Dispatch"
  | "Receive"
  | "ReportDiscrepancy"
  | "CancelRemaining"
  | "Close";
export type StockTransferPermission =
  "inventory.transfer.read" | "inventory.transfer.execute" | "inventory.transfer.approve";

export interface StockTransferCommand {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockTransferManagement";
  readonly permission: Exclude<StockTransferPermission, "inventory.transfer.read">;
  readonly operationReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly action: StockTransferAction;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StockTransferCommandRecord {
  readonly operationReference: InventoryReference;
  readonly intentHash: string;
  readonly action: StockTransferAction;
  readonly command: StockTransferCommand;
  readonly transfer: StockTransferAggregate;
  readonly movements: readonly StockMovementFact[];
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}

export interface StockTransferListQuery {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockTransferRead";
  readonly permission: "inventory.transfer.read";
  readonly stockScope: MovementStockScope;
  readonly status: StockTransferAggregate["status"] | null;
  readonly discrepancyOnly: boolean;
  readonly search: string | null;
  readonly limit: number;
}

export interface StockTransferDetailQuery {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockTransferRead";
  readonly permission: "inventory.transfer.read";
  readonly sourceScope: MovementStockScope;
  readonly destinationScope: MovementStockScope;
  readonly transferReference: InventoryReference;
}

export interface StockTransferListProjection {
  readonly projectionName: "inventory_transfer_list_v1";
  readonly projectionVersion: 1;
  readonly stockScope: MovementStockScope;
  readonly asOfUtc: InventoryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly transfers: readonly StockTransferAggregate[];
}

export interface StockTransferDetailProjection {
  readonly projectionName: "inventory_transfer_detail_v1";
  readonly projectionVersion: 1;
  readonly sourceScope: MovementStockScope;
  readonly destinationScope: MovementStockScope;
  readonly asOfUtc: InventoryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly transfer: StockTransferAggregate;
}
