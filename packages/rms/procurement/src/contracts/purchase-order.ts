import type {
  PurchaseOrder,
  PurchaseOrderFulfillment,
  PurchaseOrderLineSnapshot,
  PurchaseOrderReference,
  PurchaseOrderWorkflow,
} from "../domain/aggregates/purchase-order.js";

export type PurchaseOrderAction =
  | "CreateDraft"
  | "ReviseDraft"
  | "Submit"
  | "Approve"
  | "Issue"
  | "RecordAcknowledgement"
  | "RecordDecline"
  | "Cancel"
  | "CancelRemainder"
  | "Close";
export interface PurchaseOrderCommand {
  readonly tenantReference: PurchaseOrderReference;
  readonly brandReference: PurchaseOrderReference;
  readonly actorReference: PurchaseOrderReference;
  readonly purpose: "PurchaseOrderManagement";
  readonly permission:
    | "procurement.purchase_order.manage"
    | "procurement.purchase_order.approve"
    | "procurement.purchase_order.issue"
    | "procurement.purchase_order.response"
    | "procurement.purchase_order.cancel"
    | "procurement.purchase_order.close";
  readonly operationReference: PurchaseOrderReference;
  readonly occurredAt: string;
  readonly action: PurchaseOrderAction;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface PurchaseOrderCommandRecord {
  readonly operationReference: PurchaseOrderReference;
  readonly intentHash: string;
  readonly action: PurchaseOrderAction;
  readonly command: PurchaseOrderCommand;
  readonly purchaseOrder: PurchaseOrder;
  readonly audit: { readonly auditReference: PurchaseOrderReference };
  readonly outcome: "Applied" | "AlreadyApplied";
}
export interface PurchaseOrderQuery {
  readonly tenantReference: PurchaseOrderReference;
  readonly brandReference: PurchaseOrderReference;
  readonly actorReference: PurchaseOrderReference;
  readonly purpose: "PurchaseOrderRead";
  readonly permission: "procurement.purchase_order.read";
  readonly selectedPurchaseOrderReference: PurchaseOrderReference | null;
  readonly editor: boolean;
  readonly search: string | null;
  readonly supplierReference: PurchaseOrderReference | null;
  readonly itemReference: PurchaseOrderReference | null;
  readonly workflow: PurchaseOrderWorkflow | "All";
  readonly fulfillment: PurchaseOrderFulfillment | "All";
  readonly closure: "Open" | "Closed" | "All";
  readonly storeReference: PurchaseOrderReference | null;
  readonly buyerEntityReference: PurchaseOrderReference | null;
  readonly requiredFromUtc: string | null;
  readonly requiredUntilUtc: string | null;
  readonly overdueOnly: boolean;
  readonly discrepancyOnly: boolean;
  readonly cursor: string | null;
}
export interface PurchaseOrderProjection {
  readonly projectionName: "procurement_purchase_order_v1";
  readonly projectionVersion: number;
  readonly asOfUtc: string;
  readonly stale: boolean;
  readonly partial: boolean;
  readonly tenantReference: PurchaseOrderReference;
  readonly brandReference: PurchaseOrderReference;
  readonly permissions: {
    readonly mayManage: boolean;
    readonly mayApprove: boolean;
    readonly mayIssue: boolean;
    readonly mayRecordResponse: boolean;
    readonly mayCancel: boolean;
    readonly mayClose: boolean;
    readonly mayViewCost: boolean;
    readonly mayViewSupplierResponse: boolean;
    readonly mayViewReceipt: boolean;
    readonly mayViewDiscrepancy: boolean;
    readonly mayViewHistory: boolean;
  };
  readonly items: readonly {
    readonly purchaseOrderReference: PurchaseOrderReference;
    readonly purchaseOrderVersion: number;
    readonly supplierReference: PurchaseOrderReference;
    readonly supplierName: string;
    readonly buyerEntityReference: PurchaseOrderReference;
    readonly buyerEntityName: string;
    readonly shipToStockSiteReference: PurchaseOrderReference;
    readonly shipToLabel: string;
    readonly currency: string;
    readonly workflow: PurchaseOrderWorkflow;
    readonly fulfillment: PurchaseOrderFulfillment;
    readonly closure: "Open" | "Closed";
    readonly orderedAmount: string | null;
    readonly receivedAmount: string | null;
    readonly openAmount: string | null;
    readonly issuedAt: string | null;
    readonly expectedDeliveryUtc: string;
    readonly overdue: boolean;
    readonly discrepancyCount: number | null;
  }[];
  readonly editor: null | {
    readonly purchaseOrderReference: PurchaseOrderReference;
    readonly purchaseOrderVersion: number;
    readonly supplierReference: PurchaseOrderReference;
    readonly buyerEntityReference: PurchaseOrderReference;
    readonly shipToStockSiteReference: PurchaseOrderReference;
    readonly shipToAddressSnapshotReference: PurchaseOrderReference;
    readonly currency: string;
    readonly pendingRevisionNumber: number;
    readonly pendingRevisionLifecycle: string;
    readonly lines: readonly PurchaseOrderLineSnapshot[];
    readonly validationIssues: readonly {
      readonly code: string;
      readonly severity: "Blocking" | "Warning";
      readonly message: string;
    }[];
  };
  readonly detail: null | {
    readonly purchaseOrderReference: PurchaseOrderReference;
    readonly effectiveRevisionNumber: number;
    readonly issuedSnapshotReference: PurchaseOrderReference;
    readonly supplierResponse: null | {
      readonly response: "Acknowledged" | "Declined";
      readonly responseReference: PurchaseOrderReference;
      readonly recordedAt: string;
    };
    readonly revisions:
      | readonly {
          readonly revisionReference: PurchaseOrderReference;
          readonly revisionNumber: number;
          readonly lifecycle: string;
          readonly reasonCode: string | null;
        }[]
      | null;
    readonly receiptReferences: readonly PurchaseOrderReference[] | null;
    readonly discrepancyReferences: readonly PurchaseOrderReference[] | null;
    readonly lineCompletion: readonly {
      readonly lineReference: PurchaseOrderReference;
      readonly orderedQuantity: string;
      readonly receivedQuantity: string | null;
      readonly cancelledQuantity: string;
      readonly final: boolean;
    }[];
    readonly timeline: readonly { readonly action: string; readonly occurredAt: string }[];
  };
  readonly nextCursor: string | null;
}
