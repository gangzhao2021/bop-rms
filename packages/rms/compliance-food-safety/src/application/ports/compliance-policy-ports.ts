import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type { CompliancePolicyVersion } from "../../contracts/compliance-policy.js";
import type {
  ComplianceCode,
  ComplianceReference,
  ComplianceScope,
} from "../../contracts/compliance-dashboard.js";

export type CompliancePolicyCommand =
  | "CreateDraft"
  | "ReviseDraft"
  | "SubmitReview"
  | "ApproveVersion"
  | "PublishVersion"
  | "RetireVersion";
export interface CompliancePolicyOperation {
  readonly command: CompliancePolicyCommand;
  readonly operationReference: ComplianceReference;
  readonly intentDigest: string;
  readonly policy: CompliancePolicyVersion;
  readonly events: readonly [];
}
export interface CompliancePolicyPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: CompliancePolicyCommand;
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
    resolveOperation(reference: ComplianceReference): Promise<CompliancePolicyOperation | null>;
    loadLatest(reference: ComplianceReference): Promise<CompliancePolicyVersion | null>;
    loadVersion(reference: ComplianceReference): Promise<CompliancePolicyVersion | null>;
    hasOpenVersion(reference: ComplianceReference): Promise<boolean>;
    commit(input: {
      readonly operation: CompliancePolicyOperation;
      readonly expectedRevision: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<CompliancePolicyOperation>;
  };
  readonly reviewers: {
    validate(input: {
      readonly versionReference: ComplianceReference;
      readonly scope: ComplianceScope;
      readonly authoredByReference: ComplianceReference;
      readonly reviewedByReference: ComplianceReference;
      readonly counselReviewerReference: ComplianceReference | null;
      readonly secondApproverReference: ComplianceReference | null;
      readonly reviewedAt: string;
    }): Promise<boolean>;
  };
}
