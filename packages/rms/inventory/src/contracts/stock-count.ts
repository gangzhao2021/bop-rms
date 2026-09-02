import type { AppendAuditRecordInput } from "@bop/audit";
import type { InventoryInstant, InventoryReference } from "../domain/inventory-item.js";
import type { StockCountAggregate } from "../domain/stock-count.js";
import type { StockMovementFact } from "../domain/stock-movement.js";

export type StockCountAction =
  "Create" | "Assign" | "Start" | "SaveLine" | "Submit" | "Approve" | "Reject" | "Cancel" | "Post";

export type StockCountPermission =
  | "inventory.count.read"
  | "inventory.count.manage"
  | "inventory.count.execute"
  | "inventory.count.approve"
  | "inventory.count.post";

export interface StockCountCommand {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockCountManagement";
  readonly permission: StockCountPermission;
  readonly operationReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly action: StockCountAction;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StockCountCommandRecord {
  readonly operationReference: InventoryReference;
  readonly intentHash: string;
  readonly action: StockCountAction;
  readonly command: StockCountCommand;
  readonly count: StockCountAggregate;
  readonly movements: readonly StockMovementFact[];
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}

export interface StockCountQuery {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockCountRead";
  readonly permission: "inventory.count.read";
  readonly stockScope: import("../domain/stock-movement.js").MovementStockScope;
  readonly countReference: InventoryReference | null;
  readonly statuses: readonly StockCountAggregate["status"][];
  readonly assigneeReference: InventoryReference | null;
  readonly hasVariance: boolean | null;
  readonly overdueAt: InventoryInstant | null;
  readonly limit: number;
}

export interface StockCountReadModel {
  readonly countReference: InventoryReference;
  readonly stockScope: import("../domain/stock-movement.js").MovementStockScope;
  readonly countType: StockCountAggregate["countType"];
  readonly status: StockCountAggregate["status"];
  readonly expectedQuantityVisibility: StockCountAggregate["expectedQuantityVisibility"];
  readonly movementControl: StockCountAggregate["movementControl"];
  readonly approvalPolicy: StockCountAggregate["approvalPolicy"];
  readonly snapshotReference: InventoryReference;
  readonly snapshotCapturedAt: InventoryInstant;
  readonly assigneeReference: InventoryReference | null;
  readonly submittedBy: InventoryReference | null;
  readonly approvedBy: InventoryReference | null;
  readonly dueAt: InventoryInstant | null;
  readonly aggregateVersion: number;
  readonly lines: readonly {
    readonly lineReference: InventoryReference;
    readonly itemReference: InventoryReference;
    readonly lotReference: InventoryReference | null;
    readonly locationReference: InventoryReference;
    readonly unitCode: string;
    readonly expectedQuantity: import("../domain/inventory-item.js").InventoryDecimal | null;
    readonly countedQuantity: import("../domain/inventory-item.js").InventoryDecimal | null;
    readonly variance: import("../domain/stock-count.js").StockCountVariance | null;
    readonly varianceReasonCode: string | null;
    readonly recountNumber: number;
    readonly movementReference: InventoryReference | null;
  }[];
}

export interface StockCountProjection {
  readonly projectionName: "inventory_count_workbench_v1";
  readonly projectionVersion: 1;
  readonly stockScope: import("../domain/stock-movement.js").MovementStockScope;
  readonly asOfUtc: InventoryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly counts: readonly StockCountReadModel[];
}
