import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type { ComplianceCaseSnapshot } from "../../contracts/compliance-case.js";
import type {
  ComplianceCorrectiveActionRecord,
  ComplianceFindingRecord,
  ComplianceInspectionRecord,
} from "../../contracts/compliance-inspection-action.js";
import type {
  ComplianceCode,
  ComplianceReference,
  ComplianceScope,
} from "../../contracts/compliance-dashboard.js";

export type ComplianceInspectionActionCommand =
  | "RecordInspection"
  | "CorrectInspection"
  | "RecordFinding"
  | "ChangeFinding"
  | "AssignAction"
  | "AdvanceAction"
  | "VerifyAction";
export type ComplianceFindingActionEventType =
  | "ComplianceFindingRecorded"
  | "CriticalComplianceFindingDetected"
  | "CorrectiveActionAssigned"
  | "CorrectiveActionCompleted"
  | "CorrectiveActionVerified"
  | "CorrectiveActionVerificationFailed";
export interface ComplianceFindingActionEvent {
  readonly eventType: ComplianceFindingActionEventType;
  readonly caseReference: ComplianceReference;
  readonly recordReference: ComplianceReference;
  readonly tenantReference: ComplianceReference;
  readonly brandReference: ComplianceReference;
  readonly storeReference: ComplianceReference | null;
  readonly aggregateVersion: number;
  readonly severity: ComplianceFindingRecord["severity"];
  readonly requirementVersionReference: ComplianceReference;
  readonly occurredAt: string;
}
export interface ComplianceInspectionActionOperation {
  readonly command: ComplianceInspectionActionCommand;
  readonly operationReference: ComplianceReference;
  readonly intentDigest: string;
  readonly case: ComplianceCaseSnapshot;
  readonly inspection: ComplianceInspectionRecord | null;
  readonly finding: ComplianceFindingRecord | null;
  readonly correctiveAction: ComplianceCorrectiveActionRecord | null;
  readonly events: readonly ComplianceFindingActionEvent[];
}
export interface ComplianceInspectionActionPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: ComplianceInspectionActionCommand;
      readonly operationReference: ComplianceReference;
      readonly caseReference: ComplianceReference;
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
    ): Promise<ComplianceInspectionActionOperation | null>;
    loadCase(reference: ComplianceReference): Promise<ComplianceCaseSnapshot | null>;
    loadLatestInspection(
      reference: ComplianceReference,
    ): Promise<ComplianceInspectionRecord | null>;
    loadLatestFinding(reference: ComplianceReference): Promise<ComplianceFindingRecord | null>;
    loadLatestCorrectiveAction(
      reference: ComplianceReference,
    ): Promise<ComplianceCorrectiveActionRecord | null>;
    commit(input: {
      readonly operation: ComplianceInspectionActionOperation;
      readonly expectedAggregateVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ComplianceInspectionActionOperation>;
  };
}
