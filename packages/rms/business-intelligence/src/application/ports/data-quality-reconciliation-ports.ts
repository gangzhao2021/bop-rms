import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  DataQualityCheckSnapshot,
  DataQualityIssueActionSnapshot,
  DataQualityResultSnapshot,
  ReconciliationExceptionSnapshot,
  ReconciliationRunSnapshot,
} from "../../contracts/data-quality-reconciliation.js";
import type { ReportingDigest, ReportingReference } from "../../contracts/report-definition.js";

export type DataQualityAction =
  | "CreateCheck"
  | "ReplaceCheck"
  | "ArchiveCheck"
  | "RecordResult"
  | "ActOnIssue"
  | "RecordReconciliation"
  | "ActOnReconciliation";

export type DataQualityEvent =
  | {
      readonly eventType: "DataQualityIssueDetected";
      readonly resultReference: ReportingReference;
      readonly checkReference: ReportingReference;
      readonly checkVersionReference: ReportingReference;
      readonly datasetVersionReference: ReportingReference;
      readonly partitionCode: DataQualityResultSnapshot["partitionCode"];
      readonly scope: DataQualityCheckSnapshot["scope"];
      readonly severity: DataQualityResultSnapshot["severity"];
      readonly publicationDisposition: DataQualityResultSnapshot["publicationDisposition"];
      readonly detectedAt: string;
    }
  | {
      readonly eventType: "DataQualityIssueResolved";
      readonly resultReference: ReportingReference;
      readonly rerunResultReference: ReportingReference;
      readonly resolutionCode: NonNullable<DataQualityIssueActionSnapshot["resolutionCode"]>;
      readonly scope: DataQualityCheckSnapshot["scope"];
      readonly resolvedAt: string;
    }
  | {
      readonly eventType: "ReconciliationDifferenceDetected";
      readonly exceptionReference: ReportingReference;
      readonly runReference: ReportingReference;
      readonly scope: DataQualityCheckSnapshot["scope"];
      readonly control: ReconciliationRunSnapshot["control"];
      readonly periodFrom: string;
      readonly periodUntil: string;
      readonly unitCode: ReconciliationRunSnapshot["unitCode"];
      readonly detectedAt: string;
    };

export interface DataQualityOperationRecord {
  readonly action: DataQualityAction;
  readonly operationReference: ReportingReference;
  readonly operationIntentHash: ReportingDigest;
  readonly resultReference: ReportingReference;
  readonly event: DataQualityEvent | null;
}

export interface DataQualityAuthorizationEvidence {
  readonly tenantReference: string;
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}

export interface DataQualityReconciliationPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: DataQualityAction;
      readonly operationReference: ReportingReference;
      readonly targetReference: ReportingReference;
      readonly observedAt: string;
    }): Promise<DataQualityAuthorizationEvidence | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: ReportingDigest, right: ReportingDigest): boolean;
  };
  readonly observations: {
    authorizeReconciliation(input: {
      readonly scope: ReconciliationRunSnapshot["scope"];
      readonly leftObservationReference: ReportingReference;
      readonly rightObservationReference: ReportingReference;
      readonly control: ReconciliationRunSnapshot["control"];
    }): Promise<boolean>;
  };
  readonly repository: {
    resolveOperation(reference: ReportingReference): Promise<DataQualityOperationRecord | null>;
    loadCheck(reference: ReportingReference): Promise<DataQualityCheckSnapshot | null>;
    loadCheckVersion(reference: ReportingReference): Promise<DataQualityCheckSnapshot | null>;
    commitCheck(input: {
      readonly operation: DataQualityOperationRecord;
      readonly check: DataQualityCheckSnapshot;
      readonly expectedAggregateVersion: number | null;
      readonly audit: AppendAuditRecordInput;
    }): Promise<DataQualityOperationRecord>;
    loadResult(reference: ReportingReference): Promise<DataQualityResultSnapshot | null>;
    loadLatestIssueAction(
      resultReference: ReportingReference,
    ): Promise<DataQualityIssueActionSnapshot | null>;
    commitResult(input: {
      readonly operation: DataQualityOperationRecord;
      readonly result: DataQualityResultSnapshot;
      readonly audit: AppendAuditRecordInput;
    }): Promise<DataQualityOperationRecord>;
    commitIssueAction(input: {
      readonly operation: DataQualityOperationRecord;
      readonly action: DataQualityIssueActionSnapshot;
      readonly expectedSequence: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<DataQualityOperationRecord>;
    loadReconciliationRun(reference: ReportingReference): Promise<ReconciliationRunSnapshot | null>;
    loadLatestReconciliationException(
      exceptionReference: ReportingReference,
    ): Promise<ReconciliationExceptionSnapshot | null>;
    commitReconciliation(input: {
      readonly operation: DataQualityOperationRecord;
      readonly run: ReconciliationRunSnapshot;
      readonly exception: ReconciliationExceptionSnapshot | null;
      readonly audit: AppendAuditRecordInput;
    }): Promise<DataQualityOperationRecord>;
    commitReconciliationAction(input: {
      readonly operation: DataQualityOperationRecord;
      readonly action: ReconciliationExceptionSnapshot;
      readonly expectedSequence: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<DataQualityOperationRecord>;
  };
}
