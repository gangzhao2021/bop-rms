import type { RawBrowserCredential } from "../../contracts/browser-session.js";
import type { IdempotencyReference } from "../../contracts/authentication-session.js";
import type { ActorReference } from "../../contracts/identity-actor.js";
import type { EvidenceReference } from "../../contracts/workforce-identity-security.js";

export interface WorkforceIdentityProviderPort {
  acceptInvitation(input: {
    readonly actorReference: ActorReference;
    readonly corporateEmail: string;
    readonly idempotencyKey: IdempotencyReference;
  }): Promise<{ readonly evidenceReference: EvidenceReference }>;
  verifyTotp(input: {
    readonly actorReference: ActorReference;
    readonly challenge: RawBrowserCredential;
    readonly idempotencyKey: IdempotencyReference;
  }): Promise<{ readonly evidenceReference: EvidenceReference }>;
  issueOneTimeTemporaryCredential(input: {
    readonly actorReference: ActorReference;
    readonly idempotencyKey: IdempotencyReference;
  }): Promise<{
    readonly evidenceReference: EvidenceReference;
    readonly outcome: "Issued" | "Unknown";
  }>;
}
