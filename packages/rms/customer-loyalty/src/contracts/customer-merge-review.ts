import type { CustomerInstant, CustomerReference } from "../domain/customer-profile.js";
import type {
  CustomerMergeReview,
  CustomerProfilesMergedFact,
  MergeConflict,
  MergeEvidence,
} from "../domain/customer-merge-review.js";
import type { AppendAuditRecordInput } from "@bop/audit";

export interface CustomerMergeReviewCommand {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "CustomerDuplicateResolution";
  readonly permission: "customer.merge.review" | "customer.merge.approve";
  readonly operationReference: CustomerReference;
  readonly occurredAt: CustomerInstant;
  readonly action: "StartReview" | "Approve" | "Reject";
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface CustomerMergeReviewRecord {
  readonly operationReference: CustomerReference;
  readonly intentHash: string;
  readonly command: CustomerMergeReviewCommand;
  readonly review: CustomerMergeReview;
  readonly mergedFact: CustomerProfilesMergedFact | null;
  readonly audit: AppendAuditRecordInput;
  readonly outcome: "Applied" | "AlreadyApplied";
}
export interface CustomerMergeReviewQuery {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly purpose: "CustomerDuplicateResolution";
  readonly permission: "customer.merge.review";
  readonly reviewReference: CustomerReference | null;
  readonly exactContactReference: CustomerReference | null;
  readonly exactProfileReference: CustomerReference | null;
}
export interface CustomerMergeReviewProjection {
  readonly projectionName: "customer_merge_review_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly asOfUtc: CustomerInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayViewEvidence: boolean;
    readonly mayReview: boolean;
    readonly mayApprove: boolean;
  };
  readonly review: {
    readonly reviewReference: CustomerReference;
    readonly aggregateVersion: number;
    readonly status: CustomerMergeReview["status"];
    readonly canonicalProfileReference: CustomerReference;
    readonly candidateProfileReference: CustomerReference;
    readonly canonicalProfileVersion: number;
    readonly candidateProfileVersion: number;
    readonly evidence: readonly MergeEvidence[] | null;
    readonly conflicts: readonly MergeConflict[];
    readonly linkedAccountReferences: readonly CustomerReference[];
    readonly linkedTransactionReferences: readonly CustomerReference[];
    readonly consentEvidenceReferences: readonly CustomerReference[] | null;
    readonly impactReference: CustomerReference;
    readonly rollbackReference: CustomerReference;
    readonly requestedBy: CustomerReference;
    readonly decidedBy: CustomerReference | null;
    readonly decisionEvidenceReference: CustomerReference | null;
  } | null;
}
