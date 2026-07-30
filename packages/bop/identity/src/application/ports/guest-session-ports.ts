import type {
  GuestAdmissionEvidence,
  GuestDiningAdmissionEvidence,
  GuestDiningAdmissionReference,
  GuestEntryRequestReference,
  GuestOperationReference,
  GuestRawCredential,
  GuestSelectorHash,
  GuestSession,
  GuestSessionRecord,
  GuestSessionRevocationReason,
} from "../../contracts/guest-session.js";
import type { CanonicalInstant } from "../../contracts/identity-actor.js";

export interface GuestEntryAdmissionPort {
  consume(command: {
    readonly entryRequestReference: GuestEntryRequestReference;
    readonly operationReference: GuestOperationReference;
    readonly requestedAt: CanonicalInstant;
  }): Promise<GuestAdmissionEvidence | null>;
}

export interface GuestDiningAdmissionPort {
  consume(command: {
    readonly admissionReference: GuestDiningAdmissionReference;
    readonly operationReference: GuestOperationReference;
    readonly requestedAt: CanonicalInstant;
  }): Promise<GuestDiningAdmissionEvidence | null>;
}

export interface GuestSessionBindingPort {
  validate(session: GuestSession, observedAt: CanonicalInstant): Promise<"Current" | "Unavailable">;
}

export interface GuestSessionCredentialPort {
  generateCredential(purpose: "Session" | "Csrf"): GuestRawCredential;
  generateSessionReference(): string;
  hashCredential(purpose: "Session" | "Csrf", credential: GuestRawCredential): GuestSelectorHash;
  hashOperationIntent(intent: string): GuestSelectorHash;
  equals(left: GuestSelectorHash, right: GuestSelectorHash): boolean;
}

export interface CreateGuestSessionStoreCommand {
  readonly record: GuestSessionRecord;
}
export interface TouchGuestSessionStoreCommand {
  readonly selectorHash: GuestSelectorHash;
  readonly expectedVersion: number;
  readonly observedAt: CanonicalInstant;
  readonly idleExpiresAt: CanonicalInstant;
}
export interface RotateGuestSessionStoreCommand {
  readonly currentSelectorHash: GuestSelectorHash;
  readonly expectedVersion: number;
  readonly reason: "Rotated" | "BindingChanged" | "RiskChanged";
  readonly observedAt: CanonicalInstant;
  readonly nextRecord: GuestSessionRecord;
}
export interface RevokeGuestSessionStoreCommand {
  readonly selectorHash: GuestSelectorHash;
  readonly expectedVersion: number;
  readonly reason: GuestSessionRevocationReason;
  readonly observedAt: CanonicalInstant;
  readonly operationReference: GuestOperationReference;
  readonly operationIntentHash: GuestSelectorHash;
}

export interface GuestSessionStorePort {
  create(command: CreateGuestSessionStoreCommand): Promise<GuestSessionRecord>;
  resolve(selectorHash: GuestSelectorHash): Promise<GuestSessionRecord | null>;
  touchInteractive(command: TouchGuestSessionStoreCommand): Promise<GuestSessionRecord | null>;
  rotate(command: RotateGuestSessionStoreCommand): Promise<GuestSessionRecord>;
  revoke(command: RevokeGuestSessionStoreCommand): Promise<GuestSession | null>;
  resolveOperation(operationReference: GuestOperationReference): Promise<GuestSessionRecord | null>;
}
