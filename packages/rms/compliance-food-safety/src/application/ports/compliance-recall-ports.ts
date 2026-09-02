import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  RecallAffectedScope,
  RecallContainmentOutcomes,
  RecallDisposition,
  RecallNoticeOutcomes,
  RecallRecord,
  RecallVerification,
} from "../../contracts/compliance-recall.js";
import type {
  ComplianceCode,
  ComplianceReference,
  ComplianceScope,
} from "../../contracts/compliance-dashboard.js";

export type ComplianceRecallCommand =
  | "InitiateRecall"
  | "CalculateRecallScope"
  | "EnforceRecallContainment"
  | "CreateRecallTasks"
  | "ResolveRecallNotice"
  | "RecordRecallDisposition"
  | "VerifyRecallClosure";
export interface ComplianceRecallEvent {
  readonly eventType: "RecallInitiated" | "RecallClosed";
  readonly recordReference: ComplianceReference;
  readonly tenantReference: ComplianceReference;
  readonly brandReference: ComplianceReference;
  readonly storeReference: ComplianceReference | null;
  readonly requirementVersionReference: ComplianceReference;
  readonly severity: RecallRecord["severity"];
  readonly occurredAt: string;
}
export interface ComplianceRecallOperation {
  readonly command: ComplianceRecallCommand;
  readonly operationReference: ComplianceReference;
  readonly intentDigest: string;
  readonly recall: RecallRecord;
  readonly events: readonly ComplianceRecallEvent[];
}
export interface ComplianceRecallPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: ComplianceRecallCommand;
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
    resolveOperation(reference: ComplianceReference): Promise<ComplianceRecallOperation | null>;
    loadLatest(reference: ComplianceReference): Promise<RecallRecord | null>;
    commit(input: {
      readonly operation: ComplianceRecallOperation;
      readonly expectedRevision: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<ComplianceRecallOperation>;
  };
  readonly cases: {
    resolve(reference: ComplianceReference): Promise<{
      readonly scope: ComplianceScope;
      readonly caseType: "RecallWithdrawal";
      readonly lifecycle:
        "Open" | "Investigating" | "CorrectiveAction" | "Verification" | "Closed" | "Cancelled";
    } | null>;
  };
  readonly traceScope: {
    calculate(input: {
      readonly operationReference: ComplianceReference;
      readonly recall: RecallRecord;
      readonly traceRunReference: ComplianceReference;
      readonly requestedAt: string;
    }): Promise<RecallAffectedScope>;
  };
  readonly containment: {
    enforce(input: {
      readonly operationReference: ComplianceReference;
      readonly recall: RecallRecord;
      readonly requestedAt: string;
      readonly hardBlock: true;
      readonly overrideAllowed: false;
    }): Promise<RecallContainmentOutcomes>;
  };
  readonly tasks: {
    create(input: {
      readonly operationReference: ComplianceReference;
      readonly recall: RecallRecord;
      readonly requestedAt: string;
    }): Promise<{ readonly taskOutcomeReference: ComplianceReference }>;
  };
  readonly notices: {
    resolve(input: {
      readonly operationReference: ComplianceReference;
      readonly recall: RecallRecord;
      readonly customerOrderCount: string;
      readonly fulfillmentCount: string;
      readonly requestedAt: string;
    }): Promise<RecallNoticeOutcomes>;
  };
  readonly dispositions: {
    record(input: {
      readonly operationReference: ComplianceReference;
      readonly recall: RecallRecord;
      readonly subjectKind: RecallDisposition["subjectKind"];
      readonly subjectReference: ComplianceReference;
      readonly decision: RecallDisposition["decision"];
      readonly requestedAt: string;
    }): Promise<RecallDisposition>;
  };
  readonly verification: {
    verify(input: {
      readonly operationReference: ComplianceReference;
      readonly recall: RecallRecord;
      readonly requestedAt: string;
    }): Promise<RecallVerification>;
  };
}
