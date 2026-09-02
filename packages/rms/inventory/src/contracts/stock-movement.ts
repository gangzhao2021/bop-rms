import type { AppendAuditRecordInput } from "@bop/audit";
import type { InventoryInstant, InventoryReference } from "../domain/inventory-item.js";
import type {
  StockMovementFact,
  StockMovementType,
  MovementStockScope,
} from "../domain/stock-movement.js";

export interface StockMovementQuery {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockMovementRead";
  readonly permission: "inventory.movement.read";
  readonly stockScope: MovementStockScope;
  readonly movementReference: InventoryReference | null;
  readonly itemReference: InventoryReference | null;
  readonly movementTypes: readonly StockMovementType[];
  readonly lotReference: InventoryReference | null;
  readonly performedBy: InventoryReference | null;
  readonly occurredFrom: InventoryInstant | null;
  readonly occurredUntil: InventoryInstant | null;
  readonly corrected: boolean | null;
  readonly search: string | null;
  readonly limit: number;
}

export interface StockMovementProjection {
  readonly projectionName: "inventory_movement_explorer_v1";
  readonly projectionVersion: 1;
  readonly stockScope: MovementStockScope;
  readonly asOfUtc: InventoryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly movements: readonly StockMovementProjectionEntry[];
}

export interface StockMovementProjectionEntry {
  readonly movement: StockMovementFact;
  readonly correctedByMovementReference: InventoryReference | null;
}

export interface CorrectStockMovementCommand {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "StockMovementCorrection";
  readonly permission: "inventory.movement.correct";
  readonly operationReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly stockScope: MovementStockScope;
  readonly movementReference: InventoryReference;
  readonly expectedBalanceVersion: number;
  readonly reasonCode: string;
}

export interface StockMovementCorrectionRecord {
  readonly operationReference: InventoryReference;
  readonly intentHash: string;
  readonly command: CorrectStockMovementCommand;
  readonly original: StockMovementFact;
  readonly correction: StockMovementFact;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
