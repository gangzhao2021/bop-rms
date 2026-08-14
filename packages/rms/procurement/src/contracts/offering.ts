import type {
  OfferingConfigVersion,
  OfferingReference,
  SupplierItemOffering,
} from "../domain/aggregates/offering.js";

export interface OfferingQuery {
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly actorReference: OfferingReference;
  readonly purpose: "OfferingRead";
  readonly permission: "procurement.offering.read";
  readonly selectedOfferingReference: OfferingReference | null;
  readonly search: string | null;
  readonly supplierReference: OfferingReference | null;
  readonly inventoryItemReference: OfferingReference | null;
  readonly status: SupplierItemOffering["lifecycle"] | "All";
  readonly currency: string | null;
  readonly storeCoverageReference: OfferingReference | null;
  readonly expiringPrice: boolean | null;
  readonly qualificationIssue: boolean | null;
  readonly cursor: string | null;
}
export interface OfferingProjection {
  readonly projectionName: "procurement_offering_v1";
  readonly projectionVersion: number;
  readonly asOfUtc: string;
  readonly stale: boolean;
  readonly partial: boolean;
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly permissions: {
    readonly mayManage: boolean;
    readonly mayApprove: boolean;
    readonly mayPublish: boolean;
    readonly mayViewCost: boolean;
    readonly mayViewQualification: boolean;
    readonly mayViewHistory: boolean;
  };
  readonly items: readonly {
    readonly offeringReference: OfferingReference;
    readonly supplierReference: OfferingReference;
    readonly supplierName: string;
    readonly inventoryItemReference: OfferingReference;
    readonly inventoryItemName: string;
    readonly supplierItemCode: string;
    readonly purchaseUnit: string;
    readonly packSummary: string;
    readonly leadTimeDays: number;
    readonly minimumOrderQuantity: string;
    readonly orderMultiple: string;
    readonly currentUnitCost: string | null;
    readonly currency: string | null;
    readonly priceEffectiveUntil: string | null;
    readonly qualificationStatus: "Current" | "Expiring" | "Blocked";
    readonly lifecycle: SupplierItemOffering["lifecycle"];
    readonly sourceReference: OfferingReference;
  }[];
  readonly detail: null | {
    readonly offeringReference: OfferingReference;
    readonly offeringVersion: number;
    readonly lifecycle: SupplierItemOffering["lifecycle"];
    readonly configVersions: readonly OfferingConfigVersion[];
    readonly priceRecords: readonly {
      readonly priceRecordReference: OfferingReference;
      readonly versions: readonly {
        readonly priceVersionReference: OfferingReference;
        readonly currency: string | null;
        readonly unitCost: string | null;
        readonly priceUnit: string;
        readonly quantityTiers:
          readonly { readonly minimumQuantity: string; readonly unitCost: string }[] | null;
        readonly effectiveFrom: string;
        readonly effectiveUntil: string | null;
        readonly source: string;
        readonly scope: string;
        readonly scopeReference: OfferingReference;
      }[];
    }[];
    readonly supplierSummary: string;
    readonly inventoryItemSummary: string;
    readonly qualificationReferences: readonly OfferingReference[] | null;
    readonly historyReferences: readonly OfferingReference[] | null;
    readonly validationIssues: readonly {
      readonly code: string;
      readonly severity: "Blocking" | "Warning";
      readonly message: string;
    }[];
    readonly sourceReference: OfferingReference;
  };
  readonly nextCursor: string | null;
}
export type OfferingAction =
  | "Create"
  | "ReviseConfig"
  | "AddPriceVersion"
  | "Submit"
  | "Approve"
  | "Publish"
  | "Suspend"
  | "RestoreDraft"
  | "Archive";
export interface OfferingCommand {
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly actorReference: OfferingReference;
  readonly purpose: "OfferingManagement";
  readonly permission:
    "procurement.offering.manage" | "procurement.offering.approve" | "procurement.offering.publish";
  readonly operationReference: OfferingReference;
  readonly occurredAt: string;
  readonly action: OfferingAction;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface OfferingCommandRecord {
  readonly operationReference: OfferingReference;
  readonly intentHash: string;
  readonly action: OfferingAction;
  readonly command: OfferingCommand;
  readonly offering: SupplierItemOffering;
  readonly audit: { readonly auditReference: OfferingReference };
  readonly impact: null | {
    readonly openPurchaseOrderCount: number;
    readonly historicalPurchaseOrdersMutated: false;
  };
  readonly outcome: "Applied" | "AlreadyApplied";
}
