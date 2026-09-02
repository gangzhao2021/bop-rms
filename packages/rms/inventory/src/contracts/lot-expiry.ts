import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  InventoryDecimal,
  InventoryInstant,
  InventoryReference,
} from "../domain/inventory-item.js";
import type { LotHoldAggregate } from "../domain/lot-hold.js";
import type { MovementStockScope } from "../domain/stock-movement.js";

export type LotExpiryWindow = "All" | "Expired" | "Due7" | "Due30" | "Due90" | "NoExpiry";
export type LotExpiryStatus = "Available" | "Expired" | "Depleted" | "Quarantined";
export type LotHoldAction = "Quarantine" | "Release";

export interface LotExpiryQuery {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "LotExpiryRead";
  readonly permission: "inventory.manage";
  readonly stockScope: MovementStockScope;
  readonly search: string | null;
  readonly expiryWindow: LotExpiryWindow;
  readonly locationReference: InventoryReference | null;
  readonly holdStatus: "All" | "Held" | "NotHeld";
  readonly supplierReference: InventoryReference | null;
  readonly fefoExceptionOnly: boolean;
  readonly selectedLotReference: InventoryReference | null;
  readonly cursor: string | null;
}

export interface LotExpiryRow {
  readonly itemReference: InventoryReference;
  readonly itemName: string;
  readonly internalCode: string;
  readonly barcode: string | null;
  readonly lotReference: InventoryReference;
  readonly lotCode: string;
  readonly expiryDate: string | null;
  readonly receivedAt: InventoryInstant;
  readonly locationReference: InventoryReference;
  readonly locationLabel: string;
  readonly onHand: InventoryDecimal;
  readonly reserved: InventoryDecimal;
  readonly unitCode: string;
  readonly status: LotExpiryStatus;
  readonly holdReference: InventoryReference | null;
  readonly holdVersion: number;
  readonly supplierReference: InventoryReference | null;
  readonly supplierLabel: string | null;
  readonly receiptReference: InventoryReference | null;
  readonly fefoException: boolean;
}

export interface LotTrace {
  readonly lotReference: InventoryReference;
  readonly locationReference: InventoryReference;
  readonly receiptReference: InventoryReference | null;
  readonly supplierReference: InventoryReference | null;
  readonly movementReferences: readonly InventoryReference[];
  readonly complianceTraceReference: InventoryReference | null;
  readonly wasteHref: string;
  readonly transferHref: string;
  readonly countHref: string;
}

export interface LotExpiryProjection {
  readonly projectionName: "inventory_lot_expiry_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockScope: MovementStockScope;
  readonly asOfUtc: InventoryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly rows: readonly LotExpiryRow[];
  readonly trace: LotTrace | null;
  readonly nextCursor: string | null;
}

export interface LotHoldCommand {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "LotHoldManagement";
  readonly permission: "inventory.manage";
  readonly operationReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly action: LotHoldAction;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface LotHoldCommandRecord {
  readonly operationReference: InventoryReference;
  readonly intentHash: string;
  readonly action: LotHoldAction;
  readonly command: LotHoldCommand;
  readonly hold: LotHoldAggregate;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
