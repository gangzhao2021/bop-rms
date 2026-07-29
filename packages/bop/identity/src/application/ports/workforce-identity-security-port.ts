import type { RawBrowserCredential, SelectorHash } from "../../contracts/browser-session.js";
import type {
  CorrelationReference,
  IdempotencyReference,
  PurposeCode,
} from "../../contracts/authentication-session.js";
import type { ActorReference, CanonicalInstant } from "../../contracts/identity-actor.js";
import type {
  EvidenceReference,
  MembershipEvidenceReference,
  RecoveryReference,
  RevocationRequestReason,
  SecurityVersion,
  SessionRevocationRequest,
  StoreAssignmentEvidenceReference,
  WorkforceInvitation,
  WorkforceMfaStatus,
  WorkforceRecoveryCase,
} from "../../contracts/workforce-identity-security.js";

export interface IssueWorkforceInvitationCommand {
  readonly invitationReference: string;
  readonly actorReference: ActorReference;
  readonly inviterActorReference: ActorReference;
  readonly membershipReference: MembershipEvidenceReference;
  readonly storeAssignmentReferences: readonly StoreAssignmentEvidenceReference[];
  readonly emailDigest: SelectorHash;
  readonly selectorHash: SelectorHash;
  readonly observedAt: CanonicalInstant;
}
export interface ConsumeWorkforceInvitationCommand {
  readonly selectorHash: SelectorHash;
  readonly emailDigest: SelectorHash;
  readonly providerEvidenceReference: EvidenceReference;
  readonly observedAt: CanonicalInstant;
}
export interface RecordTotpVerifiedCommand {
  readonly actorReference: ActorReference;
  readonly expectedVersion: SecurityVersion;
  readonly providerEvidenceReference: EvidenceReference;
  readonly observedAt: CanonicalInstant;
}
export interface CreateRecoveryCaseCommand {
  readonly recovery: WorkforceRecoveryCase;
}
export interface CompleteRecoveryCaseCommand {
  readonly recoveryReference: RecoveryReference;
  readonly expectedVersion: SecurityVersion;
  readonly completedAt: CanonicalInstant;
}
export interface RevokeActorSessionsCommand {
  readonly actorReference: ActorReference;
  readonly reason: RevocationRequestReason;
  readonly purposeCode: PurposeCode;
  readonly correlationId: CorrelationReference;
  readonly idempotencyKey: IdempotencyReference;
  readonly sourceEvidenceReference: EvidenceReference;
  readonly observedAt: CanonicalInstant;
}

export interface WorkforceIdentitySecurityStorePort {
  createInvitation(command: IssueWorkforceInvitationCommand): Promise<WorkforceInvitation>;
  consumeInvitation(
    command: ConsumeWorkforceInvitationCommand,
  ): Promise<WorkforceInvitation | null>;
  getMfaStatus(actorReference: ActorReference): Promise<WorkforceMfaStatus | null>;
  recordTotpVerified(command: RecordTotpVerifiedCommand): Promise<WorkforceMfaStatus>;
  createRecoveryCase(command: CreateRecoveryCaseCommand): Promise<WorkforceRecoveryCase>;
  getRecoveryCase(recoveryReference: RecoveryReference): Promise<WorkforceRecoveryCase | null>;
  completeRecoveryCase(command: CompleteRecoveryCaseCommand): Promise<WorkforceRecoveryCase>;
  revokeActorSessions(command: RevokeActorSessionsCommand): Promise<SessionRevocationRequest>;
}

export interface IdentitySecurityCredentialPort {
  generate(): RawBrowserCredential;
  generateUuidV7(): string;
  digest(value: string): SelectorHash;
}

export interface IdentitySecuritySessionRotationPort {
  rotateAfterMfa(
    actorReference: ActorReference,
    sessionCredential: RawBrowserCredential,
  ): Promise<RawBrowserCredential>;
}
