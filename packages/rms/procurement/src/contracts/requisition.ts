import type {
  PurchaseRequisition,
  RequisitionReference,
} from "../domain/aggregates/requisition.js";

export type RequisitionAction =
  | "CreateDraft"
  | "ReviseDraft"
  | "Submit"
  | "StartReview"
  | "Approve"
  | "Reject"
  | "Cancel"
  | "AllocateToPurchaseOrderDraft"
  | "CancelRemainder";
export interface RequisitionCommand {
  readonly tenantReference: RequisitionReference;
  readonly brandReference: RequisitionReference;
  readonly actorReference: RequisitionReference;
  readonly purpose: "RequisitionManagement";
  readonly permission:
    | "procurement.requisition.manage"
    | "procurement.requisition.review"
    | "procurement.requisition.approve"
    | "procurement.requisition.allocate";
  readonly operationReference: RequisitionReference;
  readonly occurredAt: string;
  readonly action: RequisitionAction;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface RequisitionCommandRecord {
  readonly operationReference: RequisitionReference;
  readonly intentHash: string;
  readonly action: RequisitionAction;
  readonly command: RequisitionCommand;
  readonly requisition: PurchaseRequisition;
  readonly audit: { readonly auditReference: RequisitionReference };
  readonly outcome: "Applied" | "AlreadyApplied";
}
export interface RequisitionQuery {
  readonly tenantReference: RequisitionReference;
  readonly brandReference: RequisitionReference;
  readonly actorReference: RequisitionReference;
  readonly purpose: "RequisitionRead";
  readonly permission: "procurement.requisition.read";
  readonly selectedRequisitionReference: RequisitionReference | null;
  readonly search: string | null;
  readonly workflow: PurchaseRequisition["workflow"] | "All";
  readonly requestingScopeReference: RequisitionReference | null;
  readonly requesterReference: RequisitionReference | null;
  readonly urgency: PurchaseRequisition["urgency"] | "All";
  readonly unallocatedOnly: boolean;
  readonly requiredFromUtc: string | null;
  readonly requiredUntilUtc: string | null;
  readonly cursor: string | null;
}
export interface RequisitionProjection {
  readonly projectionName: "procurement_requisition_v1";
  readonly projectionVersion: number;
  readonly asOfUtc: string;
  readonly stale: boolean;
  readonly partial: boolean;
  readonly tenantReference: RequisitionReference;
  readonly brandReference: RequisitionReference;
  readonly permissions: {
    readonly mayManage: boolean;
    readonly mayReview: boolean;
    readonly mayApprove: boolean;
    readonly mayAllocate: boolean;
    readonly mayViewAmount: boolean;
    readonly mayViewApprovalIdentity: boolean;
    readonly mayViewAllocationReferences: boolean;
  };
  readonly items: readonly {
    readonly requisitionReference: RequisitionReference;
    readonly requisitionVersion: number;
    readonly requestingScopeReference: RequisitionReference;
    readonly requestingScopeLabel: string;
    readonly workflow: PurchaseRequisition["workflow"];
    readonly allocationStatus: PurchaseRequisition["allocationStatus"];
    readonly closureStatus: PurchaseRequisition["closureStatus"];
    readonly urgency: PurchaseRequisition["urgency"];
    readonly lineCount: number;
    readonly amountEstimate: string | null;
    readonly currency: string | null;
    readonly requesterReference: RequisitionReference;
    readonly approverReference: RequisitionReference | null;
    readonly requiredByUtc: string;
  }[];
  readonly detail: null | {
    readonly requisitionReference: RequisitionReference;
    readonly requisitionVersion: number;
    readonly needSourceReferences: readonly RequisitionReference[];
    readonly lines: readonly {
      readonly lineReference: RequisitionReference;
      readonly inventoryItemReference: RequisitionReference;
      readonly itemName: string;
      readonly requestedQuantity: string;
      readonly requestedUnit: string;
      readonly requiredByUtc: string;
      readonly candidateSupplierSummaries: readonly string[];
      readonly allocationReferences: readonly RequisitionReference[] | null;
    }[];
    readonly approvalReference: RequisitionReference | null;
    readonly approverReference: RequisitionReference | null;
    readonly timeline: readonly { readonly action: string; readonly occurredAt: string }[];
  };
  readonly nextCursor: string | null;
}
