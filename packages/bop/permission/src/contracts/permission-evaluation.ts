import {
  createTenantContext,
  parseCanonicalInstant,
  type BrandReference,
  type CanonicalInstant,
  type StoreReference,
  type TenantContext,
  type TenantScopeKind,
} from "@bop/tenant";

export type PermissionActorReference = NonNullable<TenantContext["actor"]["actorReference"]>;

export const permissionEvaluationErrorCodes = [
  "PERMISSION_REQUEST_INVALID",
  "PERMISSION_CONTEXT_INVALID",
] as const;
export type PermissionEvaluationErrorCode = (typeof permissionEvaluationErrorCodes)[number];

const safeMessages: Readonly<Record<PermissionEvaluationErrorCode, string>> = {
  PERMISSION_REQUEST_INVALID: "permission request is invalid",
  PERMISSION_CONTEXT_INVALID: "permission context is invalid",
};

export class PermissionEvaluationContractError extends Error {
  readonly code: PermissionEvaluationErrorCode;

  constructor(code: PermissionEvaluationErrorCode) {
    super(safeMessages[code]);
    this.name = "PermissionEvaluationContractError";
    this.code = code;
  }
}

export type BusinessAction = string & { readonly __businessAction: unique symbol };
export type PolicyReference = string & { readonly __policyReference: unique symbol };
export type EvidenceReference = string & { readonly __evidenceReference: unique symbol };
export type RoleReference = string & { readonly __roleReference: unique symbol };
export type PolicyVersion = number & { readonly __policyVersion: unique symbol };

export const permissionEvidenceSources = [
  "ExplicitDeny",
  "ExplicitAllow",
  "RolePermission",
] as const;
export type PermissionEvidenceSource = (typeof permissionEvidenceSources)[number];

export interface PermissionResourceScope {
  readonly kind: TenantScopeKind;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
}

export interface PermissionEvidence {
  readonly source: PermissionEvidenceSource;
  readonly evidenceReference: EvidenceReference;
  readonly action: BusinessAction;
  readonly actorReference: PermissionActorReference;
  readonly roleReference: RoleReference | null;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
}

export interface PermissionEvaluationRequest {
  readonly tenantContext: TenantContext;
  readonly action: BusinessAction;
  readonly resourceScope: PermissionResourceScope;
  readonly policySnapshotReference: PolicyReference;
  readonly policyVersion: PolicyVersion;
  readonly evidence: readonly PermissionEvidence[];
}

export const permissionDecisionEffects = ["Allow", "Deny"] as const;
export type PermissionDecisionEffect = (typeof permissionDecisionEffects)[number];
export const permissionDecisionReasons = [
  "EXPLICIT_DENY",
  "EXPLICIT_ALLOW",
  "ROLE_PERMISSION",
  "DEFAULT_DENY",
  "INVALID_POLICY_EVIDENCE",
] as const;
export type PermissionDecisionReason = (typeof permissionDecisionReasons)[number];
export type PermissionDecisionSource = PermissionEvidenceSource | "DefaultDeny" | "InvalidPolicy";

export interface PermissionDecision {
  readonly effect: PermissionDecisionEffect;
  readonly reason: PermissionDecisionReason;
  readonly source: PermissionDecisionSource;
  readonly action: BusinessAction;
  readonly scopeKind: TenantScopeKind;
  readonly policySnapshotReference: PolicyReference;
  readonly policyVersion: PolicyVersion;
  readonly audit: {
    readonly effect: PermissionDecisionEffect;
    readonly reason: PermissionDecisionReason;
    readonly source: PermissionDecisionSource;
  };
}

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const actionPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,7}$/u;

function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidV7Pattern.test(value))
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  return value;
}

export function parseBusinessAction(value: unknown): BusinessAction {
  if (typeof value !== "string" || value.length > 128 || !actionPattern.test(value))
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  return value as BusinessAction;
}
export function parsePolicyReference(value: unknown): PolicyReference {
  return uuid(value) as PolicyReference;
}
export function parseEvidenceReference(value: unknown): EvidenceReference {
  return uuid(value) as EvidenceReference;
}
export function parseRoleReference(value: unknown): RoleReference {
  return uuid(value) as RoleReference;
}
export function parsePolicyVersion(value: unknown): PolicyVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  return value as PolicyVersion;
}

export function revalidateTenantContext(value: TenantContext): TenantContext {
  try {
    if (!Object.isFrozen(value))
      throw new PermissionEvaluationContractError("PERMISSION_CONTEXT_INVALID");
    return createTenantContext(value.actor, value.brand, value.store, value.resolvedAt);
  } catch {
    throw new PermissionEvaluationContractError("PERMISSION_CONTEXT_INVALID");
  }
}

export function parseEvidenceInstant(value: unknown): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  }
}
