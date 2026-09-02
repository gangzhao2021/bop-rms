import type { Brand, CanonicalInstant } from "../../domain/brand-store.js";
import type {
  PlatformTenantAdministrationInput,
  PlatformTenantAdministrationVersion,
  PlatformTenantReference,
} from "../../contracts/platform-tenant-administration.js";
export const platformTenantAdministrationCommands = [
  "CreateDraft",
  "SubmitOnboarding",
  "ApproveOnboarding",
  "ActivateTenant",
  "ProposeConfiguration",
  "ApproveConfiguration",
  "RequestSuspension",
  "ApproveSuspension",
  "RequestRestore",
] as const;
export type PlatformTenantAdministrationCommand =
  (typeof platformTenantAdministrationCommands)[number];
export interface PlatformTenantAdministrationOperation {
  readonly command: PlatformTenantAdministrationCommand;
  readonly operationReference: PlatformTenantReference;
  readonly tenantReference: string;
  readonly intentDigest: string;
  readonly version: number;
  readonly candidate: PlatformTenantAdministrationVersion;
}
export interface PlatformTenantAdministrationPorts {
  readonly authorization: {
    authorize(input: {
      readonly command: PlatformTenantAdministrationCommand;
      readonly actorReference: PlatformTenantReference;
      readonly tenantReference: string;
      readonly purposeCode: string;
      readonly supportCaseReference: PlatformTenantReference;
      readonly observedAt: CanonicalInstant;
    }): Promise<{
      readonly allowed: boolean;
      readonly namedPlatformActor: boolean;
      readonly purposeBound: boolean;
      readonly supportCaseValid: boolean;
      readonly recentMfa: boolean;
    }>;
  };
  readonly evidence: {
    validateOnboarding(
      reference: PlatformTenantReference,
      observedAt: CanonicalInstant,
    ): Promise<boolean>;
    validateApproval(
      reference: PlatformTenantReference,
      observedAt: CanonicalInstant,
    ): Promise<boolean>;
    validateImpact(
      reference: PlatformTenantReference,
      observedAt: CanonicalInstant,
    ): Promise<boolean>;
  };
  readonly references: {
    validatePlan(reference: PlatformTenantReference): Promise<boolean>;
    validateCapability(reference: PlatformTenantReference): Promise<boolean>;
    validatePolicy(reference: PlatformTenantReference): Promise<boolean>;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly organization: {
    loadTenant(reference: string): Promise<Brand | null>;
    validateLifecycle(input: PlatformTenantAdministrationInput): Promise<boolean>;
  };
  readonly repository: {
    loadLatest(reference: string): Promise<PlatformTenantAdministrationVersion | null>;
    resolveOperation(
      reference: PlatformTenantReference,
    ): Promise<PlatformTenantAdministrationOperation | null>;
    commit(input: {
      readonly operation: PlatformTenantAdministrationOperation;
      readonly expectedVersion: number;
      readonly audit: {
        readonly actorReference: PlatformTenantReference;
        readonly purposeCode: string;
        readonly supportCaseReference: PlatformTenantReference;
        readonly auditReference: PlatformTenantReference;
        readonly occurredAt: CanonicalInstant;
      };
    }): Promise<PlatformTenantAdministrationOperation>;
  };
}
