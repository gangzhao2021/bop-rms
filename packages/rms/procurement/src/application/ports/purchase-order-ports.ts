import type {
  PurchaseOrderCommand,
  PurchaseOrderCommandRecord,
  PurchaseOrderProjection,
  PurchaseOrderQuery,
} from "../../contracts/purchase-order.js";
import type {
  PurchaseOrder,
  PurchaseOrderFulfillmentSnapshot,
  PurchaseOrderLineSnapshot,
  PurchaseOrderReference,
} from "../../domain/aggregates/purchase-order.js";
export interface PurchaseOrderAccess {
  readonly authorized: boolean;
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
}
export interface PurchaseOrderPorts {
  readonly authorization: {
    authorize(input: {
      tenantReference: PurchaseOrderReference;
      brandReference: PurchaseOrderReference;
      actorReference: PurchaseOrderReference;
      purpose: string;
      permission: string;
      action: string;
    }): Promise<PurchaseOrderAccess>;
  };
  readonly projection: { query(input: PurchaseOrderQuery): Promise<PurchaseOrderProjection> };
  readonly repository: {
    resolveOperation(reference: PurchaseOrderReference): Promise<PurchaseOrderCommandRecord | null>;
    load(input: {
      tenantReference: PurchaseOrderReference;
      brandReference: PurchaseOrderReference;
      purchaseOrderReference: PurchaseOrderReference;
    }): Promise<PurchaseOrder | null>;
    commit(record: PurchaseOrderCommandRecord): Promise<PurchaseOrderCommandRecord>;
  };
  readonly composition: {
    resolve(input: {
      command: PurchaseOrderCommand;
      purchaseOrder: PurchaseOrder | null;
    }): Promise<{
      tenantReference: PurchaseOrderReference;
      brandReference: PurchaseOrderReference;
      purchaseOrderReference: PurchaseOrderReference | null;
      purchaseOrderVersion: number | null;
      supplierReference: PurchaseOrderReference;
      buyerLegalEntityReference: PurchaseOrderReference;
      shipToStockSiteReference: PurchaseOrderReference;
      shipToAddressSnapshotReference: PurchaseOrderReference;
      currency: string;
      supplierActive: boolean;
      offeringsApproved: boolean;
      pricesApproved: boolean;
      requisitionsApproved: boolean;
      lines: readonly PurchaseOrderLineSnapshot[];
    }>;
  };
  readonly approval: {
    validate(input: {
      command: PurchaseOrderCommand;
      purchaseOrder: PurchaseOrder;
      lineReference: PurchaseOrderReference | null;
      quantity: string | null;
    }): Promise<{
      tenantReference: PurchaseOrderReference;
      brandReference: PurchaseOrderReference;
      purchaseOrderReference: PurchaseOrderReference;
      purchaseOrderVersion: number;
      revisionNumber: number;
      lineReference: PurchaseOrderReference | null;
      quantity: string | null;
      approvalReference: PurchaseOrderReference;
      approved: boolean;
      approvedAt: string;
    }>;
  };
  readonly issuePolicy: {
    validate(input: { command: PurchaseOrderCommand; purchaseOrder: PurchaseOrder }): Promise<{
      tenantReference: PurchaseOrderReference;
      brandReference: PurchaseOrderReference;
      purchaseOrderReference: PurchaseOrderReference;
      purchaseOrderVersion: number;
      revisionNumber: number;
      supplierReference: PurchaseOrderReference;
      supplierActive: boolean;
      buyerLegalEntityReference: PurchaseOrderReference;
      buyerAuthorityDecisionReference: PurchaseOrderReference;
      buyerAuthorityEffectiveAt: string;
      shipToStockSiteReference: PurchaseOrderReference;
      shipToAddressSnapshotReference: PurchaseOrderReference;
      currency: string;
      approvalReference: PurchaseOrderReference;
      valid: boolean;
      blockers: readonly string[];
    }>;
  };
  readonly fulfillment: {
    resolveForClose(input: {
      command: PurchaseOrderCommand;
      purchaseOrder: PurchaseOrder;
    }): Promise<{
      tenantReference: PurchaseOrderReference;
      brandReference: PurchaseOrderReference;
      purchaseOrderReference: PurchaseOrderReference;
      purchaseOrderVersion: number;
      snapshot: PurchaseOrderFulfillmentSnapshot;
    }>;
  };
  readonly audit: {
    create(input: {
      command: PurchaseOrderCommand;
      before: PurchaseOrder | null;
      after: PurchaseOrder;
    }): Promise<{ auditReference: PurchaseOrderReference }>;
  };
  readonly references: {
    generate(
      kind: "PurchaseOrder" | "Revision" | "Issue" | "SupplierResponse" | "Cancellation",
    ): PurchaseOrderReference;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
