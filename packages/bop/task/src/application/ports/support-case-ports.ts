import type {
  DiagnosticAccessGrant,
  SupportActionRecord,
  SupportCaseOperationInput,
  SupportCaseReference,
  SupportCaseVersion,
} from "../../contracts/support-case.js";

export const supportCaseCommands = [
  "Create",
  "Assign",
  "RequestAccess",
  "GrantAccess",
  "RecordAction",
  "RevokeAccess",
  "Close",
] as const;
export type SupportCaseCommand = (typeof supportCaseCommands)[number];
export interface SupportCaseOperation {
  readonly command: SupportCaseCommand;
  readonly operationReference: SupportCaseReference;
  readonly caseReference: SupportCaseReference;
  readonly version: number;
  readonly intentDigest: string;
  readonly candidate: SupportCaseVersion;
  readonly grant: DiagnosticAccessGrant | null;
  readonly action: SupportActionRecord | null;
  readonly grantReference: SupportCaseReference | null;
}
export interface SupportCasePorts {
  readonly authorization: {
    authorize(input: {
      readonly command: SupportCaseCommand;
      readonly actorReference: SupportCaseReference;
      readonly caseReference: SupportCaseReference;
      readonly tenantReference: SupportCaseReference;
      readonly storeReference: SupportCaseReference | null;
      readonly purposeCode: string;
      readonly observedAt: string;
    }): Promise<{
      readonly allowed: boolean;
      readonly namedPlatformActor: boolean;
      readonly purposeBound: boolean;
      readonly caseBound: boolean;
      readonly recentMfa: boolean;
      readonly approver: boolean;
    }>;
  };
  readonly evidence: {
    validateRequester(reference: SupportCaseReference, observedAt: string): Promise<boolean>;
    validateApproval(reference: SupportCaseReference, observedAt: string): Promise<boolean>;
    validateRecentMfa(input: {
      readonly actorReference: SupportCaseReference;
      readonly evidenceReference: SupportCaseReference;
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly scope: {
    validateTenantStore(input: {
      readonly tenantReference: SupportCaseReference;
      readonly storeReference: SupportCaseReference | null;
    }): Promise<boolean>;
  };
  readonly delegation: {
    validate(input: {
      readonly caseReference: SupportCaseReference;
      readonly actorReference: SupportCaseReference;
      readonly permissions: readonly string[];
      readonly maskingPolicyReference: SupportCaseReference;
    }): Promise<boolean>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly repository: {
    loadLatest(reference: SupportCaseReference): Promise<SupportCaseVersion | null>;
    loadGrant(reference: SupportCaseReference): Promise<DiagnosticAccessGrant | null>;
    isGrantRevoked(reference: SupportCaseReference): Promise<boolean>;
    resolveOperation(reference: SupportCaseReference): Promise<SupportCaseOperation | null>;
    commit(input: {
      readonly operation: SupportCaseOperation;
      readonly expectedVersion: number;
      readonly audit: {
        readonly actorReference: SupportCaseReference;
        readonly purposeCode: string;
        readonly caseReference: SupportCaseReference;
        readonly auditReference: SupportCaseReference;
        readonly occurredAt: string;
      };
    }): Promise<SupportCaseOperation>;
  };
}
export interface ResolveDiagnosticAccessInput {
  readonly caseReference: SupportCaseReference;
  readonly grantReference: SupportCaseReference;
  readonly actorReference: SupportCaseReference;
  readonly tenantReference: SupportCaseReference;
  readonly storeReference: SupportCaseReference | null;
  readonly purposeCode: string;
  readonly delegatedPermission: string;
  readonly observedAt: string;
}
export type DiagnosticAccessDecision =
  | Readonly<{ allowed: false; reason: "Denied" }>
  | Readonly<{
      allowed: true;
      reason: "ActiveGrant";
      grantReference: SupportCaseReference;
      expiresAt: string;
      maskingPolicyReference: SupportCaseReference;
    }>;
export type SupportCaseOperationContext = SupportCaseOperationInput;
