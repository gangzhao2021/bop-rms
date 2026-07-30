import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  DiningJoinCapability,
  DiningJoinCapabilityKind,
  DiningJoinInvitationCredential,
  DiningJoinHumanCode,
  PublicCapabilitySelectorHash,
} from "@bop/public-capability";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";

import type {
  DiningGuestContextEvidence,
  DiningHash,
  DiningIdentityAdmission,
  DiningInstant,
  DiningParticipant,
  DiningReference,
  DiningSession,
  DiningTableStartEvidence,
} from "../../contracts/dining-session.js";

export interface DiningStaffAuthorizationEvidence {
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly table: DiningTableStartEvidence;
  readonly audit: AppendAuditRecordInput;
}

export interface DiningStaffAuthorizationPort {
  authorize(input: {
    readonly operation: "StartSession" | "RegenerateJoinCredential";
    readonly tableReference: DiningReference;
    readonly operationReference: DiningReference;
    readonly observedAt: DiningInstant;
  }): Promise<DiningStaffAuthorizationEvidence | null>;
}

export interface DiningGuestContextPort {
  resolve(input: {
    readonly guestSessionReference: DiningReference;
    readonly observedAt: DiningInstant;
  }): Promise<DiningGuestContextEvidence | null>;
}

export interface DiningJoinAbusePort {
  admit(input: {
    readonly guestSessionReference: DiningReference;
    readonly kind: DiningJoinCapabilityKind;
    readonly observedAt: DiningInstant;
  }): Promise<"Admitted" | "Cooldown">;
}

export interface DiningCredentialPort {
  generateReference(
    purpose: "DiningSession" | "Participant" | "IdentityAdmission" | "JoinCapability",
  ): string;
  generateJoinCredential(
    kind: DiningJoinCapabilityKind,
  ): DiningJoinInvitationCredential | DiningJoinHumanCode;
  hashJoinCredential(
    kind: DiningJoinCapabilityKind,
    credential: DiningJoinInvitationCredential | DiningJoinHumanCode,
  ): PublicCapabilitySelectorHash;
  hashOperationIntent(intent: string): DiningHash;
  equals(left: DiningHash, right: DiningHash): boolean;
}

export interface DiningStartRecord {
  readonly session: DiningSession;
  readonly capability: DiningJoinCapability;
  readonly operationReference: DiningReference;
  readonly operationIntentHash: DiningHash;
}

export interface DiningJoinRecord {
  readonly session: DiningSession;
  readonly participant: DiningParticipant;
  readonly admission: DiningIdentityAdmission;
  readonly capability: DiningJoinCapability;
  readonly operationReference: DiningReference;
  readonly operationIntentHash: DiningHash;
}

export interface DiningJoinState {
  readonly session: DiningSession;
  readonly capability: DiningJoinCapability;
}

export interface DiningRegenerationRecord {
  readonly capability: DiningJoinCapability;
  readonly operationReference: DiningReference;
  readonly operationIntentHash: DiningHash;
}

export interface DiningSessionStorePort {
  resolveStartOperation(operationReference: DiningReference): Promise<DiningStartRecord | null>;
  start(input: {
    readonly record: DiningStartRecord;
    readonly expectedAssignmentVersion: number;
    readonly audit: AppendAuditRecordInput;
  }): Promise<DiningStartRecord>;
  resolveJoinState(selectorHash: PublicCapabilitySelectorHash): Promise<DiningJoinState | null>;
  resolveActiveJoin(diningSessionReference: DiningReference): Promise<DiningJoinState | null>;
  resolveJoinOperation(operationReference: DiningReference): Promise<DiningJoinRecord | null>;
  join(input: {
    readonly record: DiningJoinRecord;
    readonly expectedSessionVersion: number;
    readonly expectedCapabilityVersion: number;
    readonly guestSessionReference: DiningReference;
  }): Promise<DiningJoinRecord>;
  resolveRegenerationOperation(
    operationReference: DiningReference,
  ): Promise<DiningRegenerationRecord | null>;
  regenerate(input: {
    readonly session: DiningSession;
    readonly previous: DiningJoinCapability;
    readonly replacement: DiningJoinCapability;
    readonly expectedCapabilityVersion: number;
    readonly operationReference: DiningReference;
    readonly operationIntentHash: DiningHash;
    readonly audit: AppendAuditRecordInput;
  }): Promise<DiningRegenerationRecord>;
}

export interface DiningSessionPorts {
  readonly staff: DiningStaffAuthorizationPort;
  readonly guests: DiningGuestContextPort;
  readonly abuse: DiningJoinAbusePort;
  readonly credentials: DiningCredentialPort;
  readonly store: DiningSessionStorePort;
  readonly pepperVersion: number;
}
