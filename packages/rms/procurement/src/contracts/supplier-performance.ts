import type { AppendAuditRecordInput } from "@bop/audit";
import type { OfferingReference } from "../domain/aggregates/offering.js";

export interface SupplierPerformanceQuery {
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly stockSiteReference: OfferingReference | null;
  readonly actorReference: OfferingReference;
  readonly purpose: "SupplierPerformanceRead";
  readonly permission: "procurement.manage";
  readonly supplierReference: OfferingReference | null;
  readonly offeringReference: OfferingReference | null;
  readonly itemCategoryCode: string | null;
  readonly periodFromUtc: string;
  readonly periodToUtc: string;
  readonly metricThreshold: string | null;
}
export interface ExactRate {
  readonly numerator: string;
  readonly denominator: string;
  readonly percent: string | null;
}
export interface SupplierPerformanceRow {
  readonly supplierReference: OfferingReference;
  readonly supplierSummary: string;
  readonly offeringReference: OfferingReference | null;
  readonly stockSiteReference: OfferingReference;
  readonly onTimeDelivery: ExactRate;
  readonly fillRate: ExactRate;
  readonly acceptedQuality: ExactRate;
  readonly overFrequency: ExactRate;
  readonly shortFrequency: ExactRate;
  readonly rejectedFrequency: ExactRate;
  readonly damagedFrequency: ExactRate;
  readonly acknowledgementResponseSeconds: string | null;
  readonly declineCancellationRate: ExactRate;
  readonly purchasePriceVarianceAmount: string | null;
  readonly currency: string | null;
  readonly sourceFactCount: number;
  readonly incompleteFactCount: number;
  readonly factReferences: readonly OfferingReference[] | null;
  readonly manualAssessments:
    | readonly {
        readonly assessmentReference: OfferingReference;
        readonly ratingCode: string;
        readonly occurredAt: string;
      }[]
    | null;
}
export interface SupplierPerformanceProjection {
  readonly projectionName: "procurement_supplier_performance_v1";
  readonly projectionVersion: 1;
  readonly definitionVersion: 1;
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly periodFromUtc: string;
  readonly periodToUtc: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly mayDrillFacts: boolean;
  readonly mayViewPriceVariance: boolean;
  readonly mayViewManualAssessments: boolean;
  readonly mayExport: boolean;
  readonly mayOpenReviewTask: boolean;
  readonly rows: readonly SupplierPerformanceRow[];
}
export interface SupplierPerformanceCommand {
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly stockSiteReference: OfferingReference;
  readonly actorReference: OfferingReference;
  readonly purpose: "SupplierPerformanceReview";
  readonly permission: "procurement.manage";
  readonly operationReference: OfferingReference;
  readonly occurredAt: string;
  readonly action: "OpenReviewTask" | "AddManualAssessment";
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface SupplierPerformanceRecord {
  readonly operationReference: OfferingReference;
  readonly intentHash: string;
  readonly command: SupplierPerformanceCommand;
  readonly collaborationReference: OfferingReference | null;
  readonly assessment: {
    readonly assessmentReference: OfferingReference;
    readonly supplierReference: OfferingReference;
    readonly ratingCode: string;
    readonly note: string;
    readonly occurredAt: string;
  } | null;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
