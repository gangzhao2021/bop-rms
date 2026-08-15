import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  ExportAccessGrantSnapshot,
  ExportArtifactSnapshot,
  ExportGrantConsumptionSnapshot,
  ExportJobSnapshot,
  ExportJobStateSnapshot,
  ExportRevocationSnapshot,
} from "../../contracts/export-job.js";
import type { ReportingDigest, ReportingReference } from "../../contracts/report-definition.js";

export type ExportJobAction = "Queue" | "Transition" | "Revoke" | "IssueGrant" | "ConsumeGrant";
export interface ExportAuthorizationEvidence {
  readonly tenantReference: string;
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}
export interface ExportSourceAuthorization {
  readonly sourceScreenId: string;
  readonly sourceViewReference: string;
  readonly sourceProjection: string;
  readonly sourceCheckpoint: string;
  readonly permittedFieldKeys: readonly string[];
  readonly classification: ExportJobSnapshot["classification"];
  readonly stepUpSatisfied: boolean;
}
export interface ExportOperationRecord {
  readonly operationReference: ReportingReference;
  readonly intentDigest: ReportingDigest;
  readonly result:
    | {
        readonly kind: "Job";
        readonly job: ExportJobSnapshot;
        readonly state: ExportJobStateSnapshot;
      }
    | {
        readonly kind: "State";
        readonly state: ExportJobStateSnapshot;
        readonly artifact: ExportArtifactSnapshot | null;
      }
    | { readonly kind: "Revocation"; readonly revocation: ExportRevocationSnapshot }
    | { readonly kind: "Grant"; readonly grant: ExportAccessGrantSnapshot }
    | { readonly kind: "Consumption"; readonly consumption: ExportGrantConsumptionSnapshot };
}
export interface ExportJobPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: ExportJobAction;
      readonly operationReference: ReportingReference;
      readonly targetReference: ReportingReference;
      readonly observedAt: string;
    }): Promise<ExportAuthorizationEvidence | null>;
  };
  readonly source: {
    authorize(job: ExportJobSnapshot): Promise<ExportSourceAuthorization | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: ReportingDigest, right: ReportingDigest): boolean;
  };
  readonly repository: {
    loadJob(reference: ReportingReference): Promise<ExportJobSnapshot | null>;
    loadLatestState(reference: ReportingReference): Promise<ExportJobStateSnapshot | null>;
    loadArtifact(reference: ReportingReference): Promise<ExportArtifactSnapshot | null>;
    loadArtifactForJob(reference: ReportingReference): Promise<ExportArtifactSnapshot | null>;
    loadGrant(reference: ReportingReference): Promise<ExportAccessGrantSnapshot | null>;
    loadConsumption(reference: ReportingReference): Promise<ExportGrantConsumptionSnapshot | null>;
    loadRevocation(reference: ReportingReference): Promise<ExportRevocationSnapshot | null>;
    resolveOperation(reference: ReportingReference): Promise<ExportOperationRecord | null>;
    commitJob(input: {
      readonly record: ExportOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ExportOperationRecord>;
    commitState(input: {
      readonly record: ExportOperationRecord;
      readonly expectedSequence: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ExportOperationRecord>;
    commitRevocation(input: {
      readonly record: ExportOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ExportOperationRecord>;
    commitGrant(input: {
      readonly record: ExportOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ExportOperationRecord>;
    consumeGrant(input: {
      readonly record: ExportOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ExportOperationRecord>;
  };
}
