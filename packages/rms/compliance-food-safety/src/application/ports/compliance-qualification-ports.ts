import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type { ComplianceQualificationRecord } from "../../contracts/compliance-qualification.js";
import type {
  ComplianceCode,
  ComplianceReference,
  ComplianceScope,
} from "../../contracts/compliance-dashboard.js";

export type ComplianceQualificationCommand =
  "RecordQualification" | "ReviseQualification" | "RequestRenewal" | "SuspendEligibility";
export type ComplianceQualificationEventType =
  | "LicenseExpiring"
  | "LicenseExpired"
  | "LicenseSuspended"
  | "EmployeeQualificationExpiring"
  | "EmployeeQualificationExpired";
export interface ComplianceQualificationEvent {
  readonly eventType: ComplianceQualificationEventType;
  readonly recordReference: ComplianceReference;
  readonly tenantReference: ComplianceReference;
  readonly brandReference: ComplianceReference;
  readonly storeReference: ComplianceReference | null;
  readonly requirementVersionReference: ComplianceReference;
  readonly severity: ComplianceQualificationRecord["severity"];
  readonly occurredAt: string;
}
export interface ComplianceQualificationOperation {
  readonly command: ComplianceQualificationCommand;
  readonly operationReference: ComplianceReference;
  readonly intentDigest: string;
  readonly qualification: ComplianceQualificationRecord;
  readonly events: readonly ComplianceQualificationEvent[];
}
export interface ComplianceQualificationPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: ComplianceQualificationCommand;
      readonly operationReference: ComplianceReference;
      readonly targetReference: ComplianceReference;
      readonly scope: ComplianceScope;
      readonly purposeCode: ComplianceCode;
      readonly observedAt: string;
    }): Promise<{
      readonly tenantReference: string;
      readonly tenantContext: TenantContext;
      readonly permission: PermissionDecision;
      readonly audit: AppendAuditRecordInput;
    } | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly repository: {
    resolveOperation(
      reference: ComplianceReference,
    ): Promise<ComplianceQualificationOperation | null>;
    loadLatest(reference: ComplianceReference): Promise<ComplianceQualificationRecord | null>;
    commit(input: {
      readonly operation: ComplianceQualificationOperation;
      readonly expectedRevision: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ComplianceQualificationOperation>;
  };
  readonly renewalTasks: {
    request(input: {
      readonly operationReference: ComplianceReference;
      readonly qualificationReference: ComplianceReference;
      readonly scope: ComplianceScope;
      readonly requirementVersionReference: ComplianceReference;
      readonly dueAt: string;
      readonly requestedAt: string;
    }): Promise<ComplianceReference>;
  };
  readonly eligibility: {
    suspend(input: {
      readonly operationReference: ComplianceReference;
      readonly subjectKind: ComplianceQualificationRecord["subjectKind"];
      readonly subjectReference: ComplianceReference;
      readonly ownerRecordReference: ComplianceReference | null;
      readonly ownerRecordVersion: number | null;
      readonly scope: ComplianceScope;
      readonly requirementVersionReference: ComplianceReference;
      readonly requestedAt: string;
    }): Promise<ComplianceReference>;
  };
}
