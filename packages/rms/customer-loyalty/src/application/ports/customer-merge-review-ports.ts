import type {
  CustomerMergeReviewCommand,
  CustomerMergeReviewProjection,
  CustomerMergeReviewQuery,
  CustomerMergeReviewRecord,
} from "../../contracts/customer-merge-review.js";
import type { CustomerInstant, CustomerReference } from "../../domain/customer-profile.js";
import type { MergeConflict, MergeEvidence } from "../../domain/customer-merge-review.js";

export interface CustomerMergeReviewPorts {
  readonly authorization: {
    authorize(command: CustomerMergeReviewCommand | CustomerMergeReviewQuery): Promise<{
      authorized: boolean;
      mayViewEvidence: boolean;
      mayReview: boolean;
      mayApprove: boolean;
    } | null>;
  };
  readonly candidates: {
    validate(input: {
      tenantReference: CustomerReference;
      brandReference: CustomerReference;
      canonicalProfileReference: CustomerReference;
      candidateProfileReference: CustomerReference;
      canonicalProfileVersion: number;
      candidateProfileVersion: number;
      evidenceReferences: readonly CustomerReference[];
      occurredAt: CustomerInstant;
    }): Promise<{
      valid: boolean;
      sameBrand: boolean;
      broadFuzzyMatchUsed: boolean;
      evidence: readonly MergeEvidence[];
      conflicts: readonly MergeConflict[];
      linkedAccountReferences: readonly CustomerReference[];
      linkedTransactionReferences: readonly CustomerReference[];
      consentEvidenceReferences: readonly CustomerReference[];
      impactReference: CustomerReference;
      rollbackReference: CustomerReference;
    }>;
  };
  readonly approval: {
    validate(input: {
      tenantReference: CustomerReference;
      brandReference: CustomerReference;
      reviewReference: CustomerReference;
      actorReference: CustomerReference;
      occurredAt: CustomerInstant;
    }): Promise<{
      approved: boolean;
      approvalReference: CustomerReference;
      approverReference: CustomerReference;
      approvedAt: CustomerInstant;
    }>;
  };
  readonly repository: {
    load(
      reviewReference: CustomerReference,
    ): Promise<import("../../domain/customer-merge-review.js").CustomerMergeReview | null>;
    resolveOperation(
      operationReference: CustomerReference,
    ): Promise<CustomerMergeReviewRecord | null>;
    commit(record: CustomerMergeReviewRecord): Promise<CustomerMergeReviewRecord>;
  };
  readonly projection: {
    query(query: CustomerMergeReviewQuery): Promise<CustomerMergeReviewProjection>;
  };
  readonly audit: {
    create(input: {
      command: CustomerMergeReviewCommand;
      before: import("../../domain/customer-merge-review.js").CustomerMergeReview | null;
      after: import("../../domain/customer-merge-review.js").CustomerMergeReview;
    }): Promise<CustomerMergeReviewRecord["audit"]>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
