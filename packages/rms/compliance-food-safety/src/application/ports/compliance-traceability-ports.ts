import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  TraceCriteria,
  TraceEvidenceSet,
  TraceExportReceipt,
  TraceRecallOutcome,
  TraceRun,
} from "../../contracts/compliance-traceability.js";
import type {
  ComplianceCode,
  ComplianceReference,
  ComplianceScope,
} from "../../contracts/compliance-dashboard.js";

export type ComplianceTraceabilityCommand =
  "PinEvidenceSet" | "ExportEvidenceSet" | "OpenRecallFromTrace";
export interface ComplianceTraceabilityOperation {
  readonly command: ComplianceTraceabilityCommand;
  readonly operationReference: ComplianceReference;
  readonly intentDigest: string;
  readonly evidenceSet: TraceEvidenceSet | null;
  readonly exportReceipt: TraceExportReceipt | null;
  readonly recallOutcome: TraceRecallOutcome | null;
}
interface AuthorizationBase {
  readonly tenantReference: string;
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
}
export interface ComplianceTraceabilityPorts {
  readonly authorization: {
    authorizeQuery(input: {
      readonly operationReference: ComplianceReference;
      readonly scope: ComplianceScope;
      readonly purposeCode: ComplianceCode;
      readonly observedAt: string;
    }): Promise<AuthorizationBase | null>;
    authorizeCommand(input: {
      readonly command: ComplianceTraceabilityCommand;
      readonly operationReference: ComplianceReference;
      readonly targetReference: ComplianceReference;
      readonly scope: ComplianceScope;
      readonly purposeCode: ComplianceCode;
      readonly observedAt: string;
    }): Promise<(AuthorizationBase & { readonly audit: AppendAuditRecordInput }) | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly traceProjection: {
    run(input: {
      readonly operationReference: ComplianceReference;
      readonly scope: ComplianceScope;
      readonly criteria: TraceCriteria;
      readonly requestedAt: string;
    }): Promise<TraceRun | null>;
    loadRun(reference: ComplianceReference): Promise<TraceRun | null>;
  };
  readonly cases: {
    resolve(reference: ComplianceReference): Promise<{
      readonly scope: ComplianceScope;
      readonly lifecycle:
        "Open" | "Investigating" | "CorrectiveAction" | "Verification" | "Closed" | "Cancelled";
      readonly accessClass: "Restricted";
    } | null>;
  };
  readonly repository: {
    resolveOperation(
      reference: ComplianceReference,
    ): Promise<ComplianceTraceabilityOperation | null>;
    loadEvidenceSet(reference: ComplianceReference): Promise<TraceEvidenceSet | null>;
    commit(input: {
      readonly operation: ComplianceTraceabilityOperation;
      readonly expectedRevision: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ComplianceTraceabilityOperation>;
  };
  readonly artifacts: {
    exportRestricted(input: {
      readonly operationReference: ComplianceReference;
      readonly scope: ComplianceScope;
      readonly caseReference: ComplianceReference;
      readonly evidenceSet: TraceEvidenceSet;
      readonly requestedAt: string;
    }): Promise<TraceExportReceipt>;
  };
  readonly recalls: {
    openFromTrace(input: {
      readonly operationReference: ComplianceReference;
      readonly scope: ComplianceScope;
      readonly caseReference: ComplianceReference;
      readonly run: TraceRun;
      readonly requestedAt: string;
    }): Promise<TraceRecallOutcome>;
  };
}
