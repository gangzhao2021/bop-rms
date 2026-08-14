import type { AppendAuditRecordInput } from "@bop/audit";
import type { EffectivePeriodValue } from "@bop/effective-period";
import type {
  SupplierAggregate,
  SupplierInstant,
  SupplierReference,
  SupplierStatus,
} from "../domain/aggregates/supplier.js";

export type SupplierAction =
  | "Create"
  | "Update"
  | "Activate"
  | "Suspend"
  | "Deactivate"
  | "Archive"
  | "RestoreToInactive"
  | "AddQualificationVersion"
  | "ReviewQualification";
export interface SupplierQuery {
  readonly tenantReference: SupplierReference;
  readonly brandReference: SupplierReference;
  readonly actorReference: SupplierReference;
  readonly purpose: "SupplierRead";
  readonly permission: "procurement.supplier.read";
  readonly selectedSupplierReference: SupplierReference | null;
  readonly search: string | null;
  readonly approvedContactReference: SupplierReference | null;
  readonly status: SupplierStatus | "All";
  readonly supplierType: string | null;
  readonly qualification: "All" | "Current" | "Expiring" | "Expired" | "Missing";
  readonly performanceFlag: "All" | "Flagged" | "Clear";
  readonly hasOpenPurchaseOrder: boolean | null;
  readonly cursor: string | null;
}
export interface SupplierQualificationSummary {
  readonly qualificationReference: SupplierReference;
  readonly qualificationVersionReference: SupplierReference;
  readonly qualificationType: string;
  readonly jurisdiction: string;
  readonly certificateNumber: string | null;
  readonly issuer: string | null;
  readonly effectivePeriod: EffectivePeriodValue;
  readonly documentReference: SupplierReference | null;
  readonly status: "Pending" | "Rejected" | "Scheduled" | "Effective" | "Expired";
  readonly scopeKind: "Supplier" | "Offering" | "ItemCategory";
  readonly scopeReference: SupplierReference;
}
export interface SupplierProjectionRow {
  readonly supplierReference: SupplierReference;
  readonly supplierVersion: number;
  readonly supplierCode: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly supplierType: string;
  readonly status: SupplierStatus;
  readonly qualificationStatus: "Current" | "Expiring" | "Expired" | "Missing";
  readonly nextQualificationExpiry: SupplierInstant | null;
  readonly offeringCount: number | null;
  readonly openPurchaseOrderCount: number | null;
  readonly performanceSummary: string | null;
  readonly performanceFlag: boolean | null;
}
export interface SupplierDetail {
  readonly supplierReference: SupplierReference;
  readonly taxRegistrationReference: SupplierReference | null;
  readonly contacts: readonly {
    readonly contactReference: SupplierReference;
    readonly roleCode: string;
    readonly displayName: string | null;
    readonly email: string | null;
    readonly phone: string | null;
  }[];
  readonly addresses: readonly {
    readonly addressReference: SupplierReference;
    readonly addressType: string;
    readonly addressSummary: string | null;
    readonly countryCode: string;
    readonly regionCode: string;
  }[];
  readonly qualifications: readonly SupplierQualificationSummary[];
  readonly offeringReferences: readonly SupplierReference[] | null;
  readonly openPurchaseOrderReferences: readonly SupplierReference[] | null;
  readonly performanceReference: SupplierReference | null;
  readonly historyCount: number;
  readonly auditReference: SupplierReference | null;
}
export interface SupplierProjection {
  readonly projectionName: "procurement_supplier_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: SupplierReference;
  readonly brandReference: SupplierReference;
  readonly asOfUtc: SupplierInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly rows: readonly SupplierProjectionRow[];
  readonly detail: SupplierDetail | null;
  readonly nextCursor: string | null;
}
export interface SupplierCommand {
  readonly tenantReference: SupplierReference;
  readonly brandReference: SupplierReference;
  readonly actorReference: SupplierReference;
  readonly purpose: "SupplierManagement";
  readonly permission: "procurement.supplier.manage" | "procurement.qualification.review";
  readonly operationReference: SupplierReference;
  readonly occurredAt: SupplierInstant;
  readonly action: SupplierAction;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface SupplierCommandRecord {
  readonly operationReference: SupplierReference;
  readonly intentHash: string;
  readonly action: SupplierAction;
  readonly command: SupplierCommand;
  readonly supplier: SupplierAggregate;
  readonly audit: AppendAuditRecordInput;
  readonly impact: {
    readonly offeringCount: number;
    readonly openPurchaseOrderCount: number;
    readonly historicalPurchaseOrdersMutated: false;
  } | null;
  readonly outcome: "Applied" | "AlreadyApplied";
}
