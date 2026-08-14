import type { AppendAuditRecordInput } from "@bop/audit";
import type { GoodsReceipt, GoodsReceiptLine } from "../domain/goods-receipt.js";
import type { InventoryInstant, InventoryReference } from "../domain/inventory-item.js";

export type GoodsReceiptAction = "Post" | "Adjust" | "Void";
export interface GoodsReceiptCommand {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockSiteReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "GoodsReceiptManagement";
  readonly permission: "inventory.receive";
  readonly operationReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly action: GoodsReceiptAction;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface GoodsReceiptLineEvent {
  readonly receiptLineReference: InventoryReference;
  readonly purchaseOrderLineReference: InventoryReference;
  readonly inventoryItemReference: InventoryReference;
  readonly acceptedQuantity: string;
  readonly rejectedQuantity: string;
  readonly damagedQuantity: string;
  readonly unit: string;
  readonly stockMovementReference: InventoryReference | null;
  readonly discrepancyRequired: boolean;
}
export interface GoodsReceiptPostedV1 {
  readonly eventName: "GoodsReceiptPosted";
  readonly eventVersion: 1;
  readonly eventReference: InventoryReference;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockSiteReference: InventoryReference;
  readonly supplierReference: InventoryReference;
  readonly purchaseOrderReference: InventoryReference;
  readonly issuedSnapshotReference: InventoryReference;
  readonly goodsReceiptReference: InventoryReference;
  readonly receivedAt: InventoryInstant;
  readonly lines: readonly GoodsReceiptLineEvent[];
}
export interface GoodsReceiptCorrectionV1 {
  readonly eventName: "GoodsReceiptAdjusted" | "GoodsReceiptVoided";
  readonly eventVersion: 1;
  readonly eventReference: InventoryReference;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockSiteReference: InventoryReference;
  readonly purchaseOrderReference: InventoryReference;
  readonly goodsReceiptReference: InventoryReference;
  readonly correctionReference: InventoryReference;
  readonly reasonCode: string;
  readonly lines: readonly {
    readonly receiptLineReference: InventoryReference;
    readonly purchaseOrderLineReference: InventoryReference;
    readonly acceptedQuantityDelta: string;
    readonly rejectedQuantityDelta: string;
    readonly damagedQuantityDelta: string;
    readonly unit: string;
  }[];
  readonly compensatingMovementReferences: readonly InventoryReference[];
  readonly occurredAt: InventoryInstant;
}
export interface GoodsReceiptCommandRecord {
  readonly operationReference: InventoryReference;
  readonly intentHash: string;
  readonly action: GoodsReceiptAction;
  readonly command: GoodsReceiptCommand;
  readonly receipt: GoodsReceipt;
  readonly event: GoodsReceiptPostedV1 | GoodsReceiptCorrectionV1;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
export interface GoodsReceiptQuery {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockSiteReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "GoodsReceiptRead";
  readonly permission: "inventory.receive";
  readonly search: string | null;
  readonly supplierReference: InventoryReference | null;
  readonly purchaseOrderReference: InventoryReference | null;
  readonly itemReference: InventoryReference | null;
  readonly barcode: string | null;
}
export interface GoodsReceiptProjection {
  readonly projectionName: "inventory_goods_receipt_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockSiteReference: InventoryReference;
  readonly asOfUtc: InventoryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly mayViewCost: boolean;
  readonly mayViewEvidence: boolean;
  readonly mayViewTemperature: boolean;
  readonly draft: null | {
    readonly goodsReceiptReference: InventoryReference;
    readonly supplierReference: InventoryReference;
    readonly supplierSummary: string;
    readonly purchaseOrderReference: InventoryReference;
    readonly purchaseOrderVersion: number;
    readonly purchaseOrderRevisionNumber: number;
    readonly issuedSnapshotReference: InventoryReference;
    readonly receivedAt: InventoryInstant;
    readonly lines: readonly GoodsReceiptLine[];
  };
}
