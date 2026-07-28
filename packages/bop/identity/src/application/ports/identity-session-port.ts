import type {
  AuthenticationSession,
  CorrelationReference,
  IdempotencyReference,
  PurposeCode,
  RevocationReason,
  SessionPolicyCode,
  SessionReference,
  SessionRevokedEvent,
  SessionVersion,
} from "../../contracts/authentication-session.js";
import type {
  ActorReference,
  CanonicalInstant,
  IdentityActor,
} from "../../contracts/identity-actor.js";

export interface IssueAuthenticationSessionCommand {
  readonly actor: IdentityActor;
  readonly policyCode: SessionPolicyCode;
  readonly authenticatedAt: CanonicalInstant;
  readonly correlationId: CorrelationReference;
  readonly idempotencyKey: IdempotencyReference;
}

export interface ResolveAuthenticationSessionQuery {
  readonly sessionReference: SessionReference;
  readonly observedAt: CanonicalInstant;
}

export interface RevokeAuthenticationSessionCommand {
  readonly sessionReference: SessionReference;
  readonly expectedVersion: SessionVersion;
  readonly reason: RevocationReason;
  readonly actorReference: ActorReference;
  readonly purposeCode: PurposeCode;
  readonly correlationId: CorrelationReference;
  readonly idempotencyKey: IdempotencyReference;
  readonly occurredAt: CanonicalInstant;
}

export interface RotateAuthenticationSessionCommand {
  readonly sessionReference: SessionReference;
  readonly expectedVersion: SessionVersion;
  readonly reason:
    | "Login"
    | "MfaCompletion"
    | "PrivilegeElevation"
    | "StoreContextElevation"
    | "Recovery"
    | "RiskChange";
  readonly observedAt: CanonicalInstant;
  readonly correlationId: CorrelationReference;
  readonly idempotencyKey: IdempotencyReference;
}

export interface SessionRevocationResult {
  readonly session: AuthenticationSession;
  readonly event: SessionRevokedEvent;
  readonly idempotentReplay: boolean;
}

export interface IdentitySessionPort {
  issueSession(command: IssueAuthenticationSessionCommand): Promise<AuthenticationSession>;
  resolveSession(query: ResolveAuthenticationSessionQuery): Promise<AuthenticationSession>;
  revokeSession(command: RevokeAuthenticationSessionCommand): Promise<SessionRevocationResult>;
  rotateSession(command: RotateAuthenticationSessionCommand): Promise<AuthenticationSession>;
}
