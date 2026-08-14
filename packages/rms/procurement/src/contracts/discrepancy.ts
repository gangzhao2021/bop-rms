import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  DiscrepancyStatus,
  DiscrepancyType,
  SupplierDiscrepancy,
} from "../domain/aggregates/discrepancy.js";
import type { OfferingReference } from "../domain/aggregates/offering.js";
export type DiscrepancyAction =
  | "Acknowledge"
  | "Assign"
  | "RecordSupplierContact"
  | "AcceptWithinPolicy"
  | "RequestCorrection"
  | "RequestReplacement"
  | "WaiveRemainder"
  | "Close";
export interface DiscrepancyCommand {
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly stockSiteReference: OfferingReference;
  readonly actorReference: OfferingReference;
  readonly purpose: "DiscrepancyManagement";
  readonly permission: "procurement.manage";
  readonly operationReference: OfferingReference;
  readonly occurredAt: string;
  readonly action: DiscrepancyAction;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface DiscrepancyIngestionCommand {
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly stockSiteReference: OfferingReference;
  readonly actorReference: OfferingReference;
  readonly purpose: "DiscrepancyIngestion";
  readonly permission: "procurement.discrepancy.consume";
  readonly operationReference: OfferingReference;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface DiscrepancyRecord {
  readonly operationReference: OfferingReference;
  readonly intentHash: string;
  readonly command: DiscrepancyCommand | DiscrepancyIngestionCommand;
  readonly discrepancy: SupplierDiscrepancy;
  readonly collaborationReference: OfferingReference | null;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
export interface DiscrepancyQuery {
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly stockSiteReference: OfferingReference;
  readonly actorReference: OfferingReference;
  readonly purpose: "DiscrepancyRead";
  readonly permission: "procurement.manage";
  readonly search: string | null;
  readonly type: DiscrepancyType | "All";
  readonly status: DiscrepancyStatus | "All";
  readonly ownerReference: OfferingReference | null;
  readonly overdue: boolean | null;
}
export interface DiscrepancyProjection {
  readonly projectionName: "procurement_discrepancy_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly stockSiteReference: OfferingReference;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly mayViewSupplierContact: boolean;
  readonly mayViewEvidence: boolean;
  readonly mayViewCost: boolean;
  readonly mayViewHistory: boolean;
  readonly rows: readonly {
    readonly discrepancyReference: OfferingReference;
    readonly version: number;
    readonly type: DiscrepancyType;
    readonly status: DiscrepancyStatus;
    readonly purchaseOrderReference: OfferingReference;
    readonly goodsReceiptReference: OfferingReference;
    readonly supplierReference: OfferingReference;
    readonly supplierSummary: string;
    readonly itemSummary: string;
    readonly varianceQuantity: string;
    readonly unit: string;
    readonly toleranceQuantity: string;
    readonly withinTolerance: boolean;
    readonly ownerReference: OfferingReference | null;
    readonly ownerSummary: string | null;
    readonly overdue: boolean;
    readonly supplierContactOutcome: string | null;
    readonly evidenceCount: number | null;
    readonly unitCost: string | null;
    readonly history: readonly { readonly action: string; readonly occurredAt: string }[] | null;
  }[];
}
