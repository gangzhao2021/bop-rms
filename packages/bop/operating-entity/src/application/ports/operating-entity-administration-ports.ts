import type {
  BusinessFunctionAssignmentRequest,
  OperatingEntityApprovalDecision,
  OperatingEntityAuthoritySummary,
  OperatingEntityProfileVersion,
} from "../../contracts/operating-entity-administration.js";
import type { OperatingEntity, OperatingEntityReference } from "../../domain/operating-entity.js";
import type { CanonicalInstant, OrganizationVersion } from "@bop/tenant";

export type OperatingEntityAdministrationCommand =
  | "SaveProfile"
  | "SubmitForApproval"
  | "DecideApproval"
  | "ActivateEntity"
  | "SuspendEntity"
  | "RecordAuthority"
  | "AssignBusinessFunction";
export type OperatingEntityAdministrationArtifact =
  | OperatingEntityProfileVersion
  | OperatingEntityApprovalDecision
  | OperatingEntityAuthoritySummary
  | BusinessFunctionAssignmentRequest
  | OperatingEntity;
export interface OperatingEntityAdministrationOperation {
  readonly command: OperatingEntityAdministrationCommand;
  readonly operationReference: string;
  readonly operatingEntityReference: OperatingEntityReference;
  readonly intentDigest: string;
  readonly entityVersion: OrganizationVersion;
  readonly artifact: OperatingEntityAdministrationArtifact;
}
export interface OperatingEntityAdministrationPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: OperatingEntityAdministrationCommand;
      readonly actorReference: string;
      readonly operatingEntityReference: OperatingEntityReference;
      readonly purposeCode: string;
      readonly occurredAt: CanonicalInstant;
      readonly requireRecentMfa: boolean;
    }): Promise<{ readonly allowed: boolean; readonly recentMfa: boolean }>;
  };
  readonly approval: {
    validate(input: {
      readonly operatingEntityReference: OperatingEntityReference;
      readonly approvalEvidenceReference: string;
      readonly entityVersion: OrganizationVersion;
      readonly observedAt: CanonicalInstant;
    }): Promise<boolean>;
  };
  readonly assignments: {
    hasOverlap(request: BusinessFunctionAssignmentRequest): Promise<boolean>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly repository: {
    loadEntity(reference: OperatingEntityReference): Promise<OperatingEntity | null>;
    loadLatestProfile(
      reference: OperatingEntityReference,
    ): Promise<OperatingEntityProfileVersion | null>;
    loadLatestApprovalDecision(
      reference: OperatingEntityReference,
    ): Promise<OperatingEntityApprovalDecision | null>;
    resolveOperation(reference: string): Promise<OperatingEntityAdministrationOperation | null>;
    commit(input: {
      readonly operation: OperatingEntityAdministrationOperation;
      readonly expectedVersion: OrganizationVersion;
      readonly audit: {
        readonly actorReference: string;
        readonly purposeCode: string;
        readonly auditReference: string;
        readonly occurredAt: CanonicalInstant;
      };
    }): Promise<OperatingEntityAdministrationOperation>;
  };
}
