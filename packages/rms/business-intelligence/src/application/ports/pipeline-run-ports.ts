import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  BackfillRequestSnapshot,
  PipelineRunSnapshot,
  PipelineRunStateSnapshot,
} from "../../contracts/pipeline-run.js";
import type { ReportingDigest, ReportingReference } from "../../contracts/report-definition.js";

export type PipelineAction =
  | "CreateRun"
  | "AdvanceRun"
  | "RequestBackfill"
  | "ApproveBackfill"
  | "RejectBackfill"
  | "BindBackfill"
  | "CompleteBackfill"
  | "FailBackfill"
  | "CancelBackfill";
export type PipelineEvent =
  | {
      readonly eventType: "AnalyticsLoadCompleted";
      readonly runReference: ReportingReference;
      readonly pipelineVersionReference: ReportingReference;
      readonly outputDatasetVersionReference: ReportingReference;
      readonly outputPartitionCode: PipelineRunSnapshot["outputPartitionCode"];
      readonly status: "Succeeded" | "SucceededWithWarning";
      readonly watermarkOccurredAt: string | null;
      readonly occurredAt: string;
    }
  | {
      readonly eventType: "AnalyticsLoadFailed";
      readonly runReference: ReportingReference;
      readonly pipelineVersionReference: ReportingReference;
      readonly errorReference: ReportingReference;
      readonly occurredAt: string;
    }
  | {
      readonly eventType: "AnalyticsBackfillCompleted";
      readonly runReference: ReportingReference;
      readonly backfillRequestVersionReference: ReportingReference;
      readonly outputDatasetVersionReference: ReportingReference;
      readonly outputPartitionCode: PipelineRunSnapshot["outputPartitionCode"];
      readonly occurredAt: string;
    };
export interface PipelineOperationRecord {
  readonly action: PipelineAction;
  readonly operationReference: ReportingReference;
  readonly operationIntentHash: ReportingDigest;
  readonly resultReference: ReportingReference;
  readonly event: PipelineEvent | null;
}
export interface PipelineAuthorizationEvidence {
  readonly tenantReference: string;
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}
export interface PipelineRunPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: PipelineAction;
      readonly operationReference: ReportingReference;
      readonly targetReference: ReportingReference;
      readonly observedAt: string;
    }): Promise<PipelineAuthorizationEvidence | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: ReportingDigest, right: ReportingDigest): boolean;
  };
  readonly repository: {
    resolveOperation(reference: ReportingReference): Promise<PipelineOperationRecord | null>;
    loadRun(reference: ReportingReference): Promise<PipelineRunSnapshot | null>;
    loadRunByLogicalBatch(digest: ReportingDigest): Promise<PipelineRunSnapshot | null>;
    loadLatestRunState(reference: ReportingReference): Promise<PipelineRunStateSnapshot | null>;
    loadBackfill(reference: ReportingReference): Promise<BackfillRequestSnapshot | null>;
    loadBackfillVersion(reference: ReportingReference): Promise<BackfillRequestSnapshot | null>;
    commitRun(input: {
      readonly operation: PipelineOperationRecord;
      readonly run: PipelineRunSnapshot;
      readonly state: PipelineRunStateSnapshot;
      readonly audit: AppendAuditRecordInput;
    }): Promise<PipelineOperationRecord>;
    commitRunState(input: {
      readonly operation: PipelineOperationRecord;
      readonly state: PipelineRunStateSnapshot;
      readonly expectedSequence: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<PipelineOperationRecord>;
    commitBackfill(input: {
      readonly operation: PipelineOperationRecord;
      readonly request: BackfillRequestSnapshot;
      readonly expectedAggregateVersion: number | null;
      readonly audit: AppendAuditRecordInput;
    }): Promise<PipelineOperationRecord>;
  };
}
