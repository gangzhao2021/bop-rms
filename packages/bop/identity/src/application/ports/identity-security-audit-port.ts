import type {
  CorrelationReference,
  IdempotencyReference,
  PurposeCode,
} from "../../contracts/authentication-session.js";
import type { ActorReference, CanonicalInstant } from "../../contracts/identity-actor.js";

export interface IdentitySecurityAuditDescriptor {
  readonly operation:
    | "InvitationIssued"
    | "InvitationAccepted"
    | "TotpVerified"
    | "RecoveryCompleted"
    | "SessionsRevoked";
  readonly actorReference: ActorReference;
  readonly targetActorReference: ActorReference;
  readonly purposeCode: PurposeCode;
  readonly correlationId: CorrelationReference;
  readonly idempotencyKey: IdempotencyReference;
  readonly occurredAt: CanonicalInstant;
  readonly resultCount: number;
}

export interface IdentitySecurityAuditPort {
  append(descriptor: IdentitySecurityAuditDescriptor): Promise<void>;
}
