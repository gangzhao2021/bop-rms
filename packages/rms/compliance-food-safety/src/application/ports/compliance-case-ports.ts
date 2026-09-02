import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  ComplianceCaseSnapshot,
  ComplianceContainmentRecord,
  RegulatoryNotificationRecord,
} from "../../contracts/compliance-case.js";
import type {
  ComplianceCode,
  ComplianceReference,
  ComplianceScope,
} from "../../contracts/compliance-dashboard.js";

export type ComplianceCaseAction =
  | "Open"
  | "Assign"
  | "Transition"
  | "Escalate"
  | "Cancel"
  | "Close"
  | "RecordContainment"
  | "RecordNotification";
export interface ComplianceCloseGateEvidence {
  readonly caseReference: ComplianceReference;
  readonly aggregateVersion: number;
  readonly criticalFindingsReady: boolean;
  readonly mandatoryActionsComplete: boolean;
  readonly evidenceComplete: boolean;
  readonly reinspectionComplete: boolean;
  readonly regulatoryNotificationSatisfied: boolean;
  readonly linkedDomainActionsValid: boolean;
  readonly verifiedAt: string;
  readonly verifierReference: ComplianceReference;
  readonly evidenceReference: ComplianceReference;
}
export interface ComplianceCaseEvent {
  readonly eventType:
    | "ComplianceCaseOpened"
    | "ComplianceCaseEnteredCorrectiveAction"
    | "ComplianceCaseVerificationStarted"
    | "ComplianceCaseEscalated"
    | "ComplianceCaseClosed"
    | "ComplianceCaseCancelled"
    | "RegulatoryNotificationRequired"
    | "RegulatoryNotificationSubmitted";
  readonly caseReference: ComplianceReference;
  readonly tenantReference: ComplianceReference;
  readonly brandReference: ComplianceReference;
  readonly storeReference: ComplianceReference | null;
  readonly aggregateVersion: number;
  readonly severity: ComplianceCaseSnapshot["severity"];
  readonly requirementVersionReference: ComplianceReference;
  readonly occurredAt: string;
}
export interface ComplianceCaseOperationRecord {
  readonly action: ComplianceCaseAction;
  readonly operationReference: ComplianceReference;
  readonly intentDigest: string;
  readonly case: ComplianceCaseSnapshot;
  readonly containment: ComplianceContainmentRecord | null;
  readonly notification: RegulatoryNotificationRecord | null;
  readonly event: ComplianceCaseEvent | null;
}
export interface ComplianceCasePorts {
  readonly authorization: {
    authorize(input: {
      readonly action: ComplianceCaseAction;
      readonly operationReference: ComplianceReference;
      readonly caseReference: ComplianceReference;
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
    resolveOperation(reference: ComplianceReference): Promise<ComplianceCaseOperationRecord | null>;
    load(reference: ComplianceReference): Promise<ComplianceCaseSnapshot | null>;
    loadLatestContainment(
      reference: ComplianceReference,
    ): Promise<ComplianceContainmentRecord | null>;
    loadLatestNotification(
      reference: ComplianceReference,
    ): Promise<RegulatoryNotificationRecord | null>;
    commit(input: {
      readonly operation: ComplianceCaseOperationRecord;
      readonly expectedAggregateVersion: number | null;
      readonly audit: AppendAuditRecordInput;
      readonly closeGate: ComplianceCloseGateEvidence | null;
    }): Promise<ComplianceCaseOperationRecord>;
  };
}
