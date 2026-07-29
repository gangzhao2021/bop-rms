import {
  parseCorrelationReference,
  parseIdempotencyReference,
  parsePurposeCode,
  type CorrelationReference,
  type IdempotencyReference,
  type PurposeCode,
  type RevocationReason,
  type SessionReference,
} from "./authentication-session.js";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
  type ActorReference,
  type CanonicalInstant,
} from "./identity-actor.js";
import { parseSelectorHash, type SelectorHash } from "./browser-session.js";

export const workforceIdentitySecurityErrorCodes = [
  "WORKFORCE_SECURITY_INPUT_INVALID",
  "WORKFORCE_SECURITY_DENIED",
  "WORKFORCE_SECURITY_VERSION_CONFLICT",
] as const;
export type WorkforceIdentitySecurityErrorCode =
  (typeof workforceIdentitySecurityErrorCodes)[number];

export class WorkforceIdentitySecurityError extends Error {
  readonly code: WorkforceIdentitySecurityErrorCode;

  constructor(code: WorkforceIdentitySecurityErrorCode) {
    super(code === "WORKFORCE_SECURITY_VERSION_CONFLICT" ? "version conflict" : "request denied");
    this.name = "WorkforceIdentitySecurityError";
    this.code = code;
  }
}

export const invitationStatuses = ["Pending", "Accepted", "Revoked", "Expired"] as const;
export type InvitationStatus = (typeof invitationStatuses)[number];
export const mfaStatuses = [
  "Required",
  "EnrollmentPending",
  "TotpVerified",
  "ResetRequired",
] as const;
export type MfaStatus = (typeof mfaStatuses)[number];
export const recoveryStatuses = ["Pending", "Approved", "Completed", "Denied", "Expired"] as const;
export type RecoveryStatus = (typeof recoveryStatuses)[number];
export const revocationRequestReasons = [
  "GlobalLogout",
  "MembershipDisabled",
  "StoreAssignmentRemoved",
  "RoleRemoved",
  "CredentialReset",
  "CredentialCompromised",
  "Recovery",
  "Administrative",
] as const satisfies readonly RevocationReason[];
export type RevocationRequestReason = (typeof revocationRequestReasons)[number];

export type InvitationReference = string & { readonly __invitationReference: unique symbol };
export type RecoveryReference = string & { readonly __recoveryReference: unique symbol };
export type EvidenceReference = string & { readonly __evidenceReference: unique symbol };
export type MembershipEvidenceReference = string & {
  readonly __membershipEvidenceReference: unique symbol;
};
export type StoreAssignmentEvidenceReference = string & {
  readonly __storeAssignmentEvidenceReference: unique symbol;
};
export type RoleAssignmentEvidenceReference = string & {
  readonly __roleAssignmentEvidenceReference: unique symbol;
};
export type SecurityVersion = number & { readonly __securityVersion: unique symbol };

const uuid = <T extends string>(value: unknown): T => {
  try {
    return parseOpaqueUuidV7(value, "IDENTITY_INPUT_INVALID") as T;
  } catch {
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  }
};
const instant = (value: unknown): CanonicalInstant => {
  try {
    return parseCanonicalInstant(value);
  } catch {
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  }
};
const enumValue = <T extends string>(value: unknown, values: readonly T[]): T => {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  return value as T;
};
export const parseSecurityVersion = (value: unknown): SecurityVersion => {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  return value as SecurityVersion;
};
export const parseInvitationReference = (value: unknown): InvitationReference =>
  uuid<InvitationReference>(value);
export const parseRecoveryReference = (value: unknown): RecoveryReference =>
  uuid<RecoveryReference>(value);
export const parseEvidenceReference = (value: unknown): EvidenceReference =>
  uuid<EvidenceReference>(value);
export const parseMembershipEvidenceReference = (value: unknown): MembershipEvidenceReference =>
  uuid<MembershipEvidenceReference>(value);
export const parseStoreAssignmentEvidenceReference = (
  value: unknown,
): StoreAssignmentEvidenceReference => uuid<StoreAssignmentEvidenceReference>(value);
export const parseRoleAssignmentEvidenceReference = (
  value: unknown,
): RoleAssignmentEvidenceReference => uuid<RoleAssignmentEvidenceReference>(value);
const actor = (value: unknown): ActorReference => uuid<ActorReference>(value);
const closed = (value: unknown, keys: readonly string[]) => {
  try {
    return readClosedRecord(value, keys);
  } catch {
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  }
};
const boundedReferences = <T extends string>(
  value: unknown,
  parse: (item: unknown) => T,
  maximum: number,
): readonly T[] => {
  if (!Array.isArray(value) || value.length > maximum)
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  const parsed = value.map(parse);
  if (new Set(parsed).size !== parsed.length)
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  return Object.freeze(parsed);
};

export interface WorkforceInvitation {
  readonly invitationReference: InvitationReference;
  readonly actorReference: ActorReference;
  readonly inviterActorReference: ActorReference;
  readonly membershipReference: MembershipEvidenceReference;
  readonly storeAssignmentReferences: readonly StoreAssignmentEvidenceReference[];
  readonly emailDigest: SelectorHash;
  readonly selectorHash: SelectorHash;
  readonly status: InvitationStatus;
  readonly createdAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly consumedAt: CanonicalInstant | null;
  readonly providerEvidenceReference: EvidenceReference | null;
  readonly version: SecurityVersion;
}

export function createWorkforceInvitation(value: unknown): WorkforceInvitation {
  const record = closed(value, [
    "invitationReference",
    "actorReference",
    "inviterActorReference",
    "membershipReference",
    "storeAssignmentReferences",
    "emailDigest",
    "selectorHash",
    "status",
    "createdAt",
    "expiresAt",
    "consumedAt",
    "providerEvidenceReference",
    "version",
  ]);
  const createdAt = instant(record.createdAt);
  const expiresAt = instant(record.expiresAt);
  const consumedAt = record.consumedAt === null ? null : instant(record.consumedAt);
  const status = enumValue(record.status, invitationStatuses);
  if (
    Date.parse(expiresAt) !== Date.parse(createdAt) + 86_400_000 ||
    (status === "Accepted") !== (consumedAt !== null) ||
    (consumedAt !== null &&
      (Date.parse(consumedAt) < Date.parse(createdAt) ||
        Date.parse(consumedAt) >= Date.parse(expiresAt)))
  )
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  return Object.freeze({
    invitationReference: parseInvitationReference(record.invitationReference),
    actorReference: actor(record.actorReference),
    inviterActorReference: actor(record.inviterActorReference),
    membershipReference: parseMembershipEvidenceReference(record.membershipReference),
    storeAssignmentReferences: boundedReferences(
      record.storeAssignmentReferences,
      parseStoreAssignmentEvidenceReference,
      100,
    ),
    emailDigest: parseSelectorHash(record.emailDigest),
    selectorHash: parseSelectorHash(record.selectorHash),
    status,
    createdAt,
    expiresAt,
    consumedAt,
    providerEvidenceReference:
      record.providerEvidenceReference === null
        ? null
        : parseEvidenceReference(record.providerEvidenceReference),
    version: parseSecurityVersion(record.version),
  });
}

export interface WorkforceMfaStatus {
  readonly actorReference: ActorReference;
  readonly status: MfaStatus;
  readonly providerEvidenceReference: EvidenceReference | null;
  readonly verifiedAt: CanonicalInstant | null;
  readonly resetAt: CanonicalInstant | null;
  readonly version: SecurityVersion;
}

export function createWorkforceMfaStatus(value: unknown): WorkforceMfaStatus {
  const record = closed(value, [
    "actorReference",
    "status",
    "providerEvidenceReference",
    "verifiedAt",
    "resetAt",
    "version",
  ]);
  const status = enumValue(record.status, mfaStatuses);
  const verifiedAt = record.verifiedAt === null ? null : instant(record.verifiedAt);
  const resetAt = record.resetAt === null ? null : instant(record.resetAt);
  if (
    (status === "TotpVerified") !== (verifiedAt !== null) ||
    (resetAt !== null && verifiedAt !== null && Date.parse(resetAt) < Date.parse(verifiedAt))
  )
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  return Object.freeze({
    actorReference: actor(record.actorReference),
    status,
    providerEvidenceReference:
      record.providerEvidenceReference === null
        ? null
        : parseEvidenceReference(record.providerEvidenceReference),
    verifiedAt,
    resetAt,
    version: parseSecurityVersion(record.version),
  });
}

export interface WorkforceRecoveryCase {
  readonly recoveryReference: RecoveryReference;
  readonly targetActorReference: ActorReference;
  readonly requestedByActorReference: ActorReference;
  readonly approverActorReferences: readonly ActorReference[];
  readonly requiredApprovalCount: 1 | 2;
  readonly purposeCode: PurposeCode;
  readonly proofEvidenceReference: EvidenceReference;
  readonly status: RecoveryStatus;
  readonly createdAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly completedAt: CanonicalInstant | null;
  readonly version: SecurityVersion;
}

export function createWorkforceRecoveryCase(value: unknown): WorkforceRecoveryCase {
  const record = closed(value, [
    "recoveryReference",
    "targetActorReference",
    "requestedByActorReference",
    "approverActorReferences",
    "requiredApprovalCount",
    "purposeCode",
    "proofEvidenceReference",
    "status",
    "createdAt",
    "expiresAt",
    "completedAt",
    "version",
  ]);
  const targetActorReference = actor(record.targetActorReference);
  const requestedByActorReference = actor(record.requestedByActorReference);
  const approvers = boundedReferences(record.approverActorReferences, actor, 2);
  const requiredApprovalCount =
    record.requiredApprovalCount === 1 || record.requiredApprovalCount === 2
      ? record.requiredApprovalCount
      : null;
  const createdAt = instant(record.createdAt);
  const expiresAt = instant(record.expiresAt);
  const completedAt = record.completedAt === null ? null : instant(record.completedAt);
  const status = enumValue(record.status, recoveryStatuses);
  if (
    requiredApprovalCount === null ||
    approvers.length > requiredApprovalCount ||
    approvers.includes(targetActorReference) ||
    approvers.includes(requestedByActorReference) ||
    Date.parse(expiresAt) <= Date.parse(createdAt) ||
    Date.parse(expiresAt) > Date.parse(createdAt) + 86_400_000 ||
    (status === "Completed") !== (completedAt !== null) ||
    (completedAt !== null && Date.parse(completedAt) >= Date.parse(expiresAt))
  )
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  return Object.freeze({
    recoveryReference: parseRecoveryReference(record.recoveryReference),
    targetActorReference,
    requestedByActorReference,
    approverActorReferences: approvers,
    requiredApprovalCount,
    purposeCode: parsePurposeCode(record.purposeCode),
    proofEvidenceReference: parseEvidenceReference(record.proofEvidenceReference),
    status,
    createdAt,
    expiresAt,
    completedAt,
    version: parseSecurityVersion(record.version),
  });
}

export interface SessionRevocationRequest {
  readonly idempotencyKey: IdempotencyReference;
  readonly actorReference: ActorReference;
  readonly reason: RevocationRequestReason;
  readonly purposeCode: PurposeCode;
  readonly correlationId: CorrelationReference;
  readonly sourceEvidenceReference: EvidenceReference;
  readonly cutoffAt: CanonicalInstant;
  readonly completedAt: CanonicalInstant;
  readonly revokedSessionReferences: readonly SessionReference[];
  readonly version: SecurityVersion;
}

export function createSessionRevocationRequest(value: unknown): SessionRevocationRequest {
  const record = closed(value, [
    "idempotencyKey",
    "actorReference",
    "reason",
    "purposeCode",
    "correlationId",
    "sourceEvidenceReference",
    "cutoffAt",
    "completedAt",
    "revokedSessionReferences",
    "version",
  ]);
  const cutoffAt = instant(record.cutoffAt);
  const completedAt = instant(record.completedAt);
  if (Date.parse(completedAt) < Date.parse(cutoffAt))
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_INPUT_INVALID");
  return Object.freeze({
    idempotencyKey: parseIdempotencyReference(record.idempotencyKey),
    actorReference: actor(record.actorReference),
    reason: enumValue(record.reason, revocationRequestReasons),
    purposeCode: parsePurposeCode(record.purposeCode),
    correlationId: parseCorrelationReference(record.correlationId),
    sourceEvidenceReference: parseEvidenceReference(record.sourceEvidenceReference),
    cutoffAt,
    completedAt,
    revokedSessionReferences: boundedReferences(
      record.revokedSessionReferences,
      (item) => uuid<SessionReference>(item),
      100,
    ),
    version: parseSecurityVersion(record.version),
  });
}

export function assertRecentTotp(status: WorkforceMfaStatus, observedAtInput: unknown): void {
  const observedAt = instant(observedAtInput);
  if (
    status.status !== "TotpVerified" ||
    status.verifiedAt === null ||
    Date.parse(observedAt) < Date.parse(status.verifiedAt) ||
    Date.parse(observedAt) - Date.parse(status.verifiedAt) >= 900_000
  )
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
}
