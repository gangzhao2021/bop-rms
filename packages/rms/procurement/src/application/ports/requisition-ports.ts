import type {
  RequisitionCommand,
  RequisitionCommandRecord,
  RequisitionProjection,
  RequisitionQuery,
} from "../../contracts/requisition.js";
import type {
  PurchaseRequisition,
  RequisitionReference,
} from "../../domain/aggregates/requisition.js";

export interface RequisitionAccess {
  readonly authorized: boolean;
  readonly mayManage: boolean;
  readonly mayReview: boolean;
  readonly mayApprove: boolean;
  readonly mayAllocate: boolean;
  readonly mayViewAmount: boolean;
  readonly mayViewApprovalIdentity: boolean;
  readonly mayViewAllocationReferences: boolean;
}
export interface RequisitionPorts {
  readonly authorization: {
    authorize(input: {
      tenantReference: RequisitionReference;
      brandReference: RequisitionReference;
      actorReference: RequisitionReference;
      purpose: string;
      permission: string;
      action: string;
    }): Promise<RequisitionAccess>;
  };
  readonly projection: { query(input: RequisitionQuery): Promise<RequisitionProjection> };
  readonly repository: {
    resolveOperation(reference: RequisitionReference): Promise<RequisitionCommandRecord | null>;
    load(input: {
      tenantReference: RequisitionReference;
      brandReference: RequisitionReference;
      requisitionReference: RequisitionReference;
    }): Promise<PurchaseRequisition | null>;
    needSourcesAvailable(input: {
      tenantReference: RequisitionReference;
      brandReference: RequisitionReference;
      needSourceReferences: readonly RequisitionReference[];
    }): Promise<boolean>;
    commit(record: RequisitionCommandRecord): Promise<RequisitionCommandRecord>;
  };
  readonly approval: {
    validate(input: {
      command: RequisitionCommand;
      requisition: PurchaseRequisition;
      lineReference: RequisitionReference | null;
      quantity: string | null;
    }): Promise<{
      tenantReference: RequisitionReference;
      brandReference: RequisitionReference;
      requisitionReference: RequisitionReference;
      requisitionVersion: number;
      lineReference: RequisitionReference | null;
      quantity: string | null;
      approvalReference: RequisitionReference;
      approved: boolean;
      approvedAt: string;
    }>;
  };
  readonly purchaseOrderDraft: {
    allocate(input: { command: RequisitionCommand; requisition: PurchaseRequisition }): Promise<{
      tenantReference: RequisitionReference;
      brandReference: RequisitionReference;
      requestingScopeKind: PurchaseRequisition["requestingScopeKind"];
      requestingScopeReference: RequisitionReference;
      requisitionReference: RequisitionReference;
      requisitionVersion: number;
      lineReference: RequisitionReference;
      inventoryItemReference: RequisitionReference;
      requestedUnit: string;
      quantity: string;
      purchaseOrderDraftReference: RequisitionReference;
      purchaseOrderDraftLineReference: RequisitionReference;
      offeringReference: RequisitionReference;
      offeringVersionReference: RequisitionReference;
      priceRecordReference: RequisitionReference;
      priceVersionReference: RequisitionReference;
      offeringApproved: true;
      priceApproved: true;
      poWorkflow: "Draft";
      poApproved: false;
      poIssued: false;
    }>;
  };
  readonly audit: {
    create(input: {
      command: RequisitionCommand;
      before: PurchaseRequisition | null;
      after: PurchaseRequisition;
    }): Promise<{ auditReference: RequisitionReference }>;
  };
  readonly references: {
    generate(kind: "Requisition" | "Allocation" | "Cancellation"): RequisitionReference;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
