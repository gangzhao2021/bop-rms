import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type { ReportDefinitionSnapshot } from "../../contracts/report-definition.js";
import type {
  ReportArtifactRevisionSnapshot,
  ReportArtifactRevocationSnapshot,
  ReportRunSnapshot,
  ReportRunStateSnapshot,
} from "../../contracts/report-run.js";
import type { ReportingDigest, ReportingReference } from "../../contracts/report-definition.js";

export type ReportRunAction =
  "Queue" | "Rerun" | "Transition" | "RecordArtifact" | "RevokeArtifact" | "DownloadArtifact";

export interface ReportRunAuthorizationEvidence {
  readonly tenantReference: string;
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}

export interface ReportRunOperationRecord {
  readonly operationReference: ReportingReference;
  readonly intentDigest: ReportingDigest;
  readonly event:
    | {
        readonly eventType: "ReportRunQueued";
        readonly runReference: ReportingReference;
        readonly reportReference: ReportingReference;
        readonly reportVersionReference: ReportingReference;
        readonly parameterSnapshotDigest: ReportingDigest;
        readonly triggerKind: ReportRunSnapshot["triggerKind"];
        readonly queuedAt: string;
      }
    | {
        readonly eventType: "ReportRunStateRecorded";
        readonly runReference: ReportingReference;
        readonly stateReference: ReportingReference;
        readonly sequence: number;
        readonly status: ReportRunStateSnapshot["status"];
        readonly dataAsOf: string | null;
        readonly generatedAt: string | null;
        readonly rowCount: number | null;
        readonly summaryDigest: ReportingDigest | null;
        readonly errorCode: string | null;
        readonly occurredAt: string;
      }
    | {
        readonly eventType: "ReportArtifactRevisionRecorded";
        readonly artifactReference: ReportingReference;
        readonly revisionReference: ReportingReference;
        readonly runReference: ReportingReference;
        readonly revisionNumber: number;
        readonly outputAssetReference: ReportingReference;
        readonly format: ReportArtifactRevisionSnapshot["format"];
        readonly classification: ReportArtifactRevisionSnapshot["classification"];
        readonly expiresAt: string;
        readonly occurredAt: string;
      }
    | {
        readonly eventType: "ReportArtifactRevoked";
        readonly artifactReference: ReportingReference;
        readonly revisionReference: ReportingReference;
        readonly reasonCode: string;
        readonly revokedAt: string;
      }
    | null;
  readonly result:
    | {
        readonly kind: "Run";
        readonly run: ReportRunSnapshot;
        readonly state: ReportRunStateSnapshot;
      }
    | { readonly kind: "State"; readonly state: ReportRunStateSnapshot }
    | { readonly kind: "Artifact"; readonly artifact: ReportArtifactRevisionSnapshot }
    | { readonly kind: "Revocation"; readonly revocation: ReportArtifactRevocationSnapshot }
    | {
        readonly kind: "DownloadAuthorization";
        readonly revisionReference: ReportingReference;
        readonly authorizedAt: string;
      };
}

export interface ReportRunPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: ReportRunAction;
      readonly operationReference: ReportingReference;
      readonly targetReference: ReportingReference;
      readonly observedAt: string;
    }): Promise<ReportRunAuthorizationEvidence | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: ReportingDigest, right: ReportingDigest): boolean;
  };
  readonly repository: {
    loadReportDefinition(reference: ReportingReference): Promise<ReportDefinitionSnapshot | null>;
    loadRun(reference: ReportingReference): Promise<ReportRunSnapshot | null>;
    loadLatestState(reference: ReportingReference): Promise<ReportRunStateSnapshot | null>;
    loadArtifact(reference: ReportingReference): Promise<ReportArtifactRevisionSnapshot | null>;
    loadArtifactRevision(
      reference: ReportingReference,
    ): Promise<ReportArtifactRevisionSnapshot | null>;
    loadArtifactRevocation(
      reference: ReportingReference,
    ): Promise<ReportArtifactRevocationSnapshot | null>;
    resolveOperation(reference: ReportingReference): Promise<ReportRunOperationRecord | null>;
    commitRun(input: {
      readonly record: ReportRunOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ReportRunOperationRecord>;
    commitState(input: {
      readonly record: ReportRunOperationRecord;
      readonly expectedSequence: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ReportRunOperationRecord>;
    commitArtifact(input: {
      readonly record: ReportRunOperationRecord;
      readonly expectedRevision: number | null;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ReportRunOperationRecord>;
    commitRevocation(input: {
      readonly record: ReportRunOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ReportRunOperationRecord>;
    commitDownloadAudit(input: {
      readonly record: ReportRunOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ReportRunOperationRecord>;
  };
}
