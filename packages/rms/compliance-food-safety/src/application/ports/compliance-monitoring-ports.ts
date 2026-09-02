import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  CleaningRecord,
  TemperatureExcursionRecord,
  TemperatureReadingRecord,
} from "../../contracts/compliance-monitoring.js";
import type {
  ComplianceCode,
  ComplianceReference,
  ComplianceScope,
} from "../../contracts/compliance-dashboard.js";

export type ComplianceMonitoringCommand =
  "RecordReading" | "RecordExcursion" | "UpdateExcursion" | "RecordCleaning" | "UpdateCleaning";
export interface ComplianceMonitoringEvent {
  readonly eventType: "TemperatureExcursionDetected" | "CleaningVerificationFailed";
  readonly recordReference: ComplianceReference;
  readonly tenantReference: ComplianceReference;
  readonly brandReference: ComplianceReference;
  readonly storeReference: ComplianceReference | null;
  readonly requirementVersionReference: ComplianceReference;
  readonly severity: "Observation" | "Minor" | "Major" | "Critical" | "ImmediateDanger";
  readonly occurredAt: string;
}
export interface ComplianceMonitoringOperation {
  readonly command: ComplianceMonitoringCommand;
  readonly operationReference: ComplianceReference;
  readonly intentDigest: string;
  readonly reading: TemperatureReadingRecord | null;
  readonly excursion: TemperatureExcursionRecord | null;
  readonly cleaning: CleaningRecord | null;
  readonly events: readonly ComplianceMonitoringEvent[];
}
export interface ComplianceMonitoringPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: ComplianceMonitoringCommand;
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
    resolveOperation(reference: ComplianceReference): Promise<ComplianceMonitoringOperation | null>;
    loadReading(reference: ComplianceReference): Promise<TemperatureReadingRecord | null>;
    loadLatestReading(input: {
      readonly scope: ComplianceScope;
      readonly policyVersionReference: ComplianceReference;
      readonly targetReference: ComplianceReference;
      readonly measurementTypeCode: ComplianceCode;
    }): Promise<TemperatureReadingRecord | null>;
    loadLatestExcursion(reference: ComplianceReference): Promise<TemperatureExcursionRecord | null>;
    loadLatestCleaning(reference: ComplianceReference): Promise<CleaningRecord | null>;
    commit(input: {
      readonly operation: ComplianceMonitoringOperation;
      readonly expectedVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ComplianceMonitoringOperation>;
  };
}
