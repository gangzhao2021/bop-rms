import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  InventoryDecimal,
  InventoryInstant,
  InventoryReference,
} from "../domain/inventory-item.js";
import type {
  ReplenishmentNeedAggregate,
  ReplenishmentNeedStatus,
} from "../domain/replenishment-need.js";
import type { MovementStockScope } from "../domain/stock-movement.js";

export type ReplenishmentUrgency = "Low" | "Normal" | "High" | "Critical";
export type ReplenishmentAction = "Acknowledge" | "CreateRequisitionDraft" | "Dismiss";

export interface ReplenishmentQuery {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "ReplenishmentRead";
  readonly permission: "inventory.manage" | "procurement.requisition.create";
  readonly stockScope: MovementStockScope;
  readonly search: string | null;
  readonly storeReference: InventoryReference | null;
  readonly status: ReplenishmentNeedStatus | "All";
  readonly urgency: ReplenishmentUrgency | "All";
  readonly supplier: "All" | "Mapped" | "Unmapped";
  readonly supplierReference: InventoryReference | null;
  readonly cursor: string | null;
}

export interface ReplenishmentRow {
  readonly needReference: InventoryReference;
  readonly needVersion: number;
  readonly itemReference: InventoryReference;
  readonly itemName: string;
  readonly internalCode: string;
  readonly available: InventoryDecimal;
  readonly reorderPoint: InventoryDecimal;
  readonly safetyStock: InventoryDecimal;
  readonly forecastQuantity: InventoryDecimal;
  readonly forecastReference: InventoryReference;
  readonly forecastAsOfUtc: InventoryInstant;
  readonly suggestedQuantity: InventoryDecimal;
  readonly baseUnitCode: string;
  readonly requiredBy: string;
  readonly urgency: ReplenishmentUrgency;
  readonly reasonCode: string;
  readonly preferredSupplierMappingReference: InventoryReference | null;
  readonly preferredSupplierReference: InventoryReference | null;
  readonly preferredSupplierSummary: string | null;
  readonly status: ReplenishmentNeedStatus;
  readonly requisitionReference: InventoryReference | null;
}

export interface ReplenishmentProjection {
  readonly projectionName: "inventory_replenishment_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockScope: MovementStockScope;
  readonly asOfUtc: InventoryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly rows: readonly ReplenishmentRow[];
  readonly nextCursor: string | null;
}

export interface ReplenishmentCommand {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "ReplenishmentManagement";
  readonly permission: "inventory.manage" | "procurement.requisition.create";
  readonly operationReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly action: ReplenishmentAction;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ReplenishmentCommandRecord {
  readonly operationReference: InventoryReference;
  readonly intentHash: string;
  readonly action: ReplenishmentAction;
  readonly command: ReplenishmentCommand;
  readonly need: ReplenishmentNeedAggregate;
  readonly requisitionReference: InventoryReference | null;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
