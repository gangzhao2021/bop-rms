import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { PublishingApprovalEvidence, PublishingValidationEvidence } from "@bop/publishing";
import type { TenantContext } from "@bop/tenant";
import type {
  ReportDefinitionSnapshot,
  ReportScheduleSnapshot,
  ReportingDigest,
  ReportingReference,
} from "../../contracts/report-definition.js";

export type ReportDefinitionAction =
  "CreateDraft" | "ReplaceDraft" | "SubmitReview" | "Publish" | "Archive";

export interface ReportDefinitionEvent {
  readonly eventType:
    | "ReportDefinitionDraftCreated"
    | "ReportDefinitionDraftReplaced"
    | "ReportDefinitionReviewSubmitted"
    | "ReportDefinitionPublished"
    | "ReportDefinitionArchived";
  readonly reportReference: ReportingReference;
  readonly versionReference: ReportingReference;
  readonly tenantReference: ReportingReference;
  readonly brandReference: ReportingReference;
  readonly storeReference: ReportingReference | null;
  readonly aggregateVersion: number;
  readonly lifecycle: ReportDefinitionSnapshot["lifecycle"];
  readonly certificationStatus: ReportDefinitionSnapshot["certificationStatus"];
  readonly snapshotDigest: ReportingDigest;
  readonly occurredAt: string;
}

export interface ReportScheduleEvent {
  readonly eventType: "ReportScheduleVersionRecorded";
  readonly scheduleReference: ReportingReference;
  readonly scheduleVersionReference: ReportingReference;
  readonly reportReference: ReportingReference;
  readonly reportVersionReference: ReportingReference;
  readonly tenantReference: ReportingReference;
  readonly brandReference: ReportingReference;
  readonly storeReference: ReportingReference | null;
  readonly status: ReportScheduleSnapshot["status"];
  readonly cadence: ReportScheduleSnapshot["cadence"];
  readonly format: ReportScheduleSnapshot["format"];
  readonly timezone: string;
  readonly occurredAt: string;
}

export interface ReportDefinitionOperationRecord {
  readonly action: ReportDefinitionAction;
  readonly operationReference: ReportingReference;
  readonly operationIntentHash: ReportingDigest;
  readonly aggregate: ReportDefinitionSnapshot;
  readonly event: ReportDefinitionEvent;
}

export interface ReportScheduleOperationRecord {
  readonly operationReference: ReportingReference;
  readonly operationIntentHash: ReportingDigest;
  readonly schedule: ReportScheduleSnapshot;
  readonly event: ReportScheduleEvent;
}

export interface ReportingAuthorizationEvidence {
  readonly tenantReference: string;
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}

export interface ReportDefinitionPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: ReportDefinitionAction | "Schedule";
      readonly operationReference: ReportingReference;
      readonly reportReference: ReportingReference;
      readonly observedAt: string;
    }): Promise<ReportingAuthorizationEvidence | null>;
  };
  readonly publishing: {
    validate(snapshot: ReportDefinitionSnapshot): Promise<PublishingValidationEvidence | null>;
    approve(input: {
      readonly snapshot: ReportDefinitionSnapshot;
      readonly validation: PublishingValidationEvidence;
    }): Promise<PublishingApprovalEvidence | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: ReportingDigest, right: ReportingDigest): boolean;
  };
  readonly repository: {
    load(reference: ReportingReference): Promise<ReportDefinitionSnapshot | null>;
    codeAvailable(input: {
      readonly scope: ReportDefinitionSnapshot["scope"];
      readonly stableCode: string;
    }): Promise<boolean>;
    resolveOperation(
      reference: ReportingReference,
    ): Promise<ReportDefinitionOperationRecord | null>;
    create(input: {
      readonly record: ReportDefinitionOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ReportDefinitionOperationRecord>;
    commit(input: {
      readonly record: ReportDefinitionOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly validation: PublishingValidationEvidence;
      readonly approval: PublishingApprovalEvidence | null;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ReportDefinitionOperationRecord>;
    loadSchedule(reference: ReportingReference): Promise<ReportScheduleSnapshot | null>;
    resolveScheduleOperation(
      reference: ReportingReference,
    ): Promise<ReportScheduleOperationRecord | null>;
    commitSchedule(input: {
      readonly record: ReportScheduleOperationRecord;
      readonly expectedScheduleVersion: number | null;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ReportScheduleOperationRecord>;
  };
}
