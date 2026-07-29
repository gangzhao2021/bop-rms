import {
  parseCorrelationReference,
  parseIdempotencyReference,
  parsePurposeCode,
  type CorrelationReference,
  type IdempotencyReference,
  type PurposeCode,
} from "../contracts/authentication-session.js";
import {
  parseRawBrowserCredential,
  type RawBrowserCredential,
  type SelectorHash,
} from "../contracts/browser-session.js";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  type ActorReference,
  type CanonicalInstant,
} from "../contracts/identity-actor.js";
import {
  createWorkforceRecoveryCase,
  parseEvidenceReference,
  parseMembershipEvidenceReference,
  parseRecoveryReference,
  parseRoleAssignmentEvidenceReference,
  parseStoreAssignmentEvidenceReference,
  revocationRequestReasons,
  WorkforceIdentitySecurityError,
  type EvidenceReference,
  type MembershipEvidenceReference,
  type RevocationRequestReason,
  type RoleAssignmentEvidenceReference,
  type SessionRevocationRequest,
  type StoreAssignmentEvidenceReference,
  type WorkforceInvitation,
  type WorkforceMfaStatus,
  type WorkforceRecoveryCase,
} from "../contracts/workforce-identity-security.js";
import type {
  IdentitySecurityCredentialPort,
  IdentitySecuritySessionRotationPort,
  WorkforceIdentitySecurityStorePort,
} from "./ports/workforce-identity-security-port.js";
import type { WorkforceIdentityProviderPort } from "./ports/workforce-identity-provider-port.js";
import type { IdentitySecurityAuditPort } from "./ports/identity-security-audit-port.js";

export interface WorkforceIdentitySecurityServiceOptions {
  readonly store: WorkforceIdentitySecurityStorePort;
  readonly provider: WorkforceIdentityProviderPort;
  readonly credentials: IdentitySecurityCredentialPort;
  readonly sessions: IdentitySecuritySessionRotationPort;
  readonly audit: IdentitySecurityAuditPort;
  readonly now?: () => unknown;
}

export interface SecurityOperationContext {
  readonly actingActorReference: ActorReference;
  readonly purposeCode: PurposeCode;
  readonly correlationId: CorrelationReference;
  readonly idempotencyKey: IdempotencyReference;
}

const actor = (value: unknown): ActorReference => {
  try {
    return parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID") as ActorReference;
  } catch {
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
  }
};
const normalizeEmail = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    value !== value.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
  )
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
  return value.toLowerCase();
};
const context = (value: {
  actingActorReference: unknown;
  purposeCode: unknown;
  correlationId: unknown;
  idempotencyKey: unknown;
}): SecurityOperationContext => {
  try {
    return Object.freeze({
      actingActorReference: actor(value.actingActorReference),
      purposeCode: parsePurposeCode(value.purposeCode),
      correlationId: parseCorrelationReference(value.correlationId),
      idempotencyKey: parseIdempotencyReference(value.idempotencyKey),
    });
  } catch {
    throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
  }
};

export class WorkforceIdentitySecurityService {
  readonly #store: WorkforceIdentitySecurityStorePort;
  readonly #provider: WorkforceIdentityProviderPort;
  readonly #credentials: IdentitySecurityCredentialPort;
  readonly #sessions: IdentitySecuritySessionRotationPort;
  readonly #audit: IdentitySecurityAuditPort;
  readonly #now: () => unknown;

  constructor(options: WorkforceIdentitySecurityServiceOptions) {
    this.#store = options.store;
    this.#provider = options.provider;
    this.#credentials = options.credentials;
    this.#sessions = options.sessions;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #observedAt(): CanonicalInstant {
    try {
      return parseCanonicalInstant(this.#now());
    } catch {
      throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
    }
  }

  async issueInvitation(input: {
    readonly actorReference: unknown;
    readonly membershipReference: unknown;
    readonly storeAssignmentReferences: readonly unknown[];
    readonly corporateEmail: unknown;
    readonly operation: SecurityOperationContext;
  }): Promise<{
    readonly invitation: WorkforceInvitation;
    readonly selector: RawBrowserCredential;
  }> {
    const operation = context(input.operation);
    const observedAt = this.#observedAt();
    const actorReference = actor(input.actorReference);
    const email = normalizeEmail(input.corporateEmail);
    const selector = this.#credentials.generate();
    const invitation = await this.#store.createInvitation({
      invitationReference: this.#credentials.generateUuidV7(),
      actorReference,
      inviterActorReference: operation.actingActorReference,
      membershipReference: parseMembershipEvidenceReference(input.membershipReference),
      storeAssignmentReferences: Object.freeze(
        input.storeAssignmentReferences.map(parseStoreAssignmentEvidenceReference),
      ),
      emailDigest: this.#credentials.digest(email),
      selectorHash: this.#credentials.digest(selector),
      observedAt,
    });
    await this.#audit.append({
      operation: "InvitationIssued",
      actorReference: operation.actingActorReference,
      targetActorReference: actorReference,
      purposeCode: operation.purposeCode,
      correlationId: operation.correlationId,
      idempotencyKey: operation.idempotencyKey,
      occurredAt: observedAt,
      resultCount: 1,
    });
    return Object.freeze({ invitation, selector });
  }

  async acceptInvitation(input: {
    readonly selector: unknown;
    readonly corporateEmail: unknown;
    readonly operation: SecurityOperationContext;
  }): Promise<WorkforceInvitation> {
    const operation = context(input.operation);
    const observedAt = this.#observedAt();
    const selector = parseRawBrowserCredential(input.selector);
    const email = normalizeEmail(input.corporateEmail);
    const provider = await this.#provider.acceptInvitation({
      actorReference: operation.actingActorReference,
      corporateEmail: email,
      idempotencyKey: operation.idempotencyKey,
    });
    const invitation = await this.#store.consumeInvitation({
      selectorHash: this.#credentials.digest(selector),
      emailDigest: this.#credentials.digest(email),
      providerEvidenceReference: parseEvidenceReference(provider.evidenceReference),
      observedAt,
    });
    if (invitation === null || invitation.actorReference !== operation.actingActorReference)
      throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
    await this.#audit.append({
      operation: "InvitationAccepted",
      actorReference: operation.actingActorReference,
      targetActorReference: invitation.actorReference,
      purposeCode: operation.purposeCode,
      correlationId: operation.correlationId,
      idempotencyKey: operation.idempotencyKey,
      occurredAt: observedAt,
      resultCount: 1,
    });
    return invitation;
  }

  async completeTotp(input: {
    readonly actorReference: unknown;
    readonly challenge: unknown;
    readonly sessionCredential: unknown;
    readonly operation: SecurityOperationContext;
  }): Promise<{
    readonly mfa: WorkforceMfaStatus;
    readonly nextSessionCredential: RawBrowserCredential;
  }> {
    const operation = context(input.operation);
    const observedAt = this.#observedAt();
    const actorReference = actor(input.actorReference);
    if (actorReference !== operation.actingActorReference)
      throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
    const current = await this.#store.getMfaStatus(actorReference);
    if (current === null || current.status === "TotpVerified")
      throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
    const provider = await this.#provider.verifyTotp({
      actorReference,
      challenge: parseRawBrowserCredential(input.challenge),
      idempotencyKey: operation.idempotencyKey,
    });
    const mfa = await this.#store.recordTotpVerified({
      actorReference,
      expectedVersion: current.version,
      providerEvidenceReference: parseEvidenceReference(provider.evidenceReference),
      observedAt,
    });
    const nextSessionCredential = await this.#sessions.rotateAfterMfa(
      actorReference,
      parseRawBrowserCredential(input.sessionCredential),
    );
    await this.#audit.append({
      operation: "TotpVerified",
      actorReference,
      targetActorReference: actorReference,
      purposeCode: operation.purposeCode,
      correlationId: operation.correlationId,
      idempotencyKey: operation.idempotencyKey,
      occurredAt: observedAt,
      resultCount: 1,
    });
    return Object.freeze({ mfa, nextSessionCredential });
  }

  async createRecovery(input: {
    readonly targetActorReference: unknown;
    readonly approverActorReferences: readonly unknown[];
    readonly requiredApprovalCount: 1 | 2;
    readonly proofEvidenceReference: unknown;
    readonly operation: SecurityOperationContext;
  }): Promise<WorkforceRecoveryCase> {
    const operation = context(input.operation);
    const observedAt = this.#observedAt();
    return this.#store.createRecoveryCase({
      recovery: createWorkforceRecoveryCase({
        recoveryReference: this.#credentials.generateUuidV7(),
        targetActorReference: actor(input.targetActorReference),
        requestedByActorReference: operation.actingActorReference,
        approverActorReferences: input.approverActorReferences.map(actor),
        requiredApprovalCount: input.requiredApprovalCount,
        purposeCode: operation.purposeCode,
        proofEvidenceReference: parseEvidenceReference(input.proofEvidenceReference),
        status:
          input.approverActorReferences.length === input.requiredApprovalCount
            ? "Approved"
            : "Pending",
        createdAt: observedAt,
        expiresAt: new Date(Date.parse(observedAt) + 86_400_000).toISOString(),
        completedAt: null,
        version: 1,
      }),
    });
  }

  async completeRecovery(input: {
    readonly recoveryReference: unknown;
    readonly operation: SecurityOperationContext;
  }): Promise<{
    readonly recovery: WorkforceRecoveryCase;
    readonly revocation: SessionRevocationRequest;
    readonly providerEvidenceReference: EvidenceReference;
  }> {
    const operation = context(input.operation);
    const observedAt = this.#observedAt();
    const recoveryReference = parseRecoveryReference(input.recoveryReference);
    const current = await this.#store.getRecoveryCase(recoveryReference);
    if (
      current === null ||
      current.status !== "Approved" ||
      current.approverActorReferences.length !== current.requiredApprovalCount ||
      Date.parse(observedAt) >= Date.parse(current.expiresAt)
    )
      throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
    const revocation = await this.revokeActorSessions({
      actorReference: current.targetActorReference,
      reason: "Recovery",
      sourceEvidenceReference: current.proofEvidenceReference,
      operation,
    });
    const provider = await this.#provider.issueOneTimeTemporaryCredential({
      actorReference: current.targetActorReference,
      idempotencyKey: operation.idempotencyKey,
    });
    if (provider.outcome !== "Issued")
      throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
    const recovery = await this.#store.completeRecoveryCase({
      recoveryReference,
      expectedVersion: current.version,
      completedAt: observedAt,
    });
    await this.#audit.append({
      operation: "RecoveryCompleted",
      actorReference: operation.actingActorReference,
      targetActorReference: current.targetActorReference,
      purposeCode: operation.purposeCode,
      correlationId: operation.correlationId,
      idempotencyKey: operation.idempotencyKey,
      occurredAt: observedAt,
      resultCount: revocation.revokedSessionReferences.length,
    });
    return Object.freeze({
      recovery,
      revocation,
      providerEvidenceReference: parseEvidenceReference(provider.evidenceReference),
    });
  }

  async revokeActorSessions(input: {
    readonly actorReference: unknown;
    readonly reason: RevocationRequestReason;
    readonly sourceEvidenceReference: unknown;
    readonly operation: SecurityOperationContext;
  }): Promise<SessionRevocationRequest> {
    const operation = context(input.operation);
    const observedAt = this.#observedAt();
    if (!revocationRequestReasons.includes(input.reason))
      throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
    const result = await this.#store.revokeActorSessions({
      actorReference: actor(input.actorReference),
      reason: input.reason,
      purposeCode: operation.purposeCode,
      correlationId: operation.correlationId,
      idempotencyKey: operation.idempotencyKey,
      sourceEvidenceReference: parseEvidenceReference(input.sourceEvidenceReference),
      observedAt,
    });
    await this.#audit.append({
      operation: "SessionsRevoked",
      actorReference: operation.actingActorReference,
      targetActorReference: result.actorReference,
      purposeCode: operation.purposeCode,
      correlationId: operation.correlationId,
      idempotencyKey: operation.idempotencyKey,
      occurredAt: result.completedAt,
      resultCount: result.revokedSessionReferences.length,
    });
    return result;
  }
}

export function roleRemovalEvidenceReference(value: unknown): RoleAssignmentEvidenceReference {
  return parseRoleAssignmentEvidenceReference(value);
}

export function membershipEvidenceReference(value: unknown): MembershipEvidenceReference {
  return parseMembershipEvidenceReference(value);
}

export function storeAssignmentEvidenceReference(value: unknown): StoreAssignmentEvidenceReference {
  return parseStoreAssignmentEvidenceReference(value);
}

export type { SelectorHash };
