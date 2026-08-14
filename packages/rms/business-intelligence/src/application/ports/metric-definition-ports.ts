import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { PublishingApprovalEvidence, PublishingValidationEvidence } from "@bop/publishing";
import type { TenantContext } from "@bop/tenant";
import type { MetricDefinitionSnapshot } from "../../contracts/metric-definition.js";
import type { ReportingDigest, ReportingReference } from "../../contracts/report-definition.js";

export type MetricDefinitionAction =
  | "CreateDraft"
  | "ReplaceDraft"
  | "CreateRevision"
  | "SubmitReview"
  | "Certify"
  | "Deprecate"
  | "Archive";

export interface MetricDefinitionEvent {
  readonly eventType:
    | "MetricDefinitionDraftRecorded"
    | "MetricDefinitionReviewSubmitted"
    | "MetricDefinitionPublished"
    | "MetricCertified"
    | "MetricDeprecated"
    | "MetricArchived";
  readonly metricReference: ReportingReference;
  readonly versionReference: ReportingReference;
  readonly tenantReference: ReportingReference;
  readonly brandReference: ReportingReference;
  readonly storeReference: ReportingReference | null;
  readonly aggregateVersion: number;
  readonly lifecycle: MetricDefinitionSnapshot["lifecycle"];
  readonly certificationStatus: MetricDefinitionSnapshot["certificationStatus"];
  readonly snapshotDigest: ReportingDigest;
  readonly replacementMetricReference: ReportingReference | null;
  readonly occurredAt: string;
}

export interface MetricDefinitionOperationRecord {
  readonly action: MetricDefinitionAction;
  readonly operationReference: ReportingReference;
  readonly operationIntentHash: ReportingDigest;
  readonly aggregate: MetricDefinitionSnapshot;
  readonly validationEvidenceReference: ReportingReference | null;
  readonly businessApprovalEvidenceReference: ReportingReference | null;
  readonly dataApprovalEvidenceReference: ReportingReference | null;
  readonly events: readonly MetricDefinitionEvent[];
}

export interface MetricAuthorizationEvidence {
  readonly tenantReference: string;
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}

export interface MetricDefinitionPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: MetricDefinitionAction;
      readonly operationReference: ReportingReference;
      readonly metricReference: ReportingReference;
      readonly observedAt: string;
    }): Promise<MetricAuthorizationEvidence | null>;
  };
  readonly publishing: {
    validate(snapshot: MetricDefinitionSnapshot): Promise<PublishingValidationEvidence | null>;
    approve(input: {
      readonly role: "BusinessOwner" | "DataOwner";
      readonly snapshot: MetricDefinitionSnapshot;
      readonly validation: PublishingValidationEvidence;
    }): Promise<PublishingApprovalEvidence | null>;
  };
  readonly metrics: {
    replacementIsCertified(input: {
      readonly metricReference: ReportingReference;
      readonly scope: MetricDefinitionSnapshot["scope"];
    }): Promise<boolean>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: ReportingDigest, right: ReportingDigest): boolean;
  };
  readonly repository: {
    load(reference: ReportingReference): Promise<MetricDefinitionSnapshot | null>;
    codeAvailable(input: {
      readonly scope: MetricDefinitionSnapshot["scope"];
      readonly stableCode: string;
    }): Promise<boolean>;
    resolveOperation(
      reference: ReportingReference,
    ): Promise<MetricDefinitionOperationRecord | null>;
    create(input: {
      readonly record: MetricDefinitionOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<MetricDefinitionOperationRecord>;
    commit(input: {
      readonly record: MetricDefinitionOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly validation: PublishingValidationEvidence | null;
      readonly businessApproval: PublishingApprovalEvidence | null;
      readonly dataApproval: PublishingApprovalEvidence | null;
      readonly audit: AppendAuditRecordInput;
    }): Promise<MetricDefinitionOperationRecord>;
  };
}
