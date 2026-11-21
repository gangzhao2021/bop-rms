import type {
  GuestDiningBindingPreparation,
  GuestDiningBindingProof,
  GuestDiningBindingOwnerEvidence,
  completeGuestDiningBinding,
} from "../../contracts/guest-dining-binding-preparation.js";
import type {
  GuestRawCredential,
  GuestSelectorHash,
  GuestSession,
} from "../../contracts/guest-session.js";
import type { CanonicalInstant } from "../../contracts/identity-actor.js";
import type {
  GuestSessionCredentialPort,
  GuestSessionStorePort,
  GuestDiningAdmissionPort,
} from "./guest-session-ports.js";

export type GuestDiningBindingCompletion = ReturnType<typeof completeGuestDiningBinding>;

export interface GuestDiningBindingStorePort {
  prepare(
    record: GuestDiningBindingPreparation,
    at: CanonicalInstant,
  ): Promise<GuestDiningBindingPreparation>;
  acknowledge(input: {
    readonly operationReference: string;
    readonly currentSelectorHash: GuestSelectorHash;
    readonly proof: GuestDiningBindingProof;
    readonly observedAt: CanonicalInstant;
  }): Promise<GuestDiningBindingPreparation>;
  activate(input: {
    readonly operationReference: string;
    readonly currentSelectorHash: GuestSelectorHash;
    readonly proof: GuestDiningBindingProof;
    readonly ownerEvidence: GuestDiningBindingOwnerEvidence;
    readonly observedAt: CanonicalInstant;
  }): Promise<GuestDiningBindingPreparation>;
  complete(input: {
    readonly operationReference: string;
    readonly sessionSelectorHash: GuestSelectorHash;
    readonly csrfSelectorHash: GuestSelectorHash;
    readonly observedAt: CanonicalInstant;
  }): Promise<GuestDiningBindingCompletion>;
}

export interface GuestDiningBindingReservation {
  readonly operationReference: string;
  readonly admissionReference: string;
  readonly guestSessionReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly publicTableReference: string;
  readonly diningSessionReference: string;
  readonly diningParticipantReference: string;
  readonly expectedGuestVersion: number;
  readonly evaluatedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}

export interface GuestDiningBindingOwnerPort extends GuestDiningAdmissionPort {
  /** Read-only current reservation; never consume an admission before candidate acknowledgement. */
  reserveAdmission(input: {
    readonly operationReference: string;
    readonly admissionReference: string;
    readonly session: GuestSession;
    readonly observedAt: CanonicalInstant;
  }): Promise<GuestDiningBindingReservation | null>;
}

export interface GuestDiningBindingServiceOptions {
  readonly authorization: {
    authorize(input: {
      readonly sessionCredential: unknown;
      readonly csrfCredential: unknown;
      readonly observedAt?: unknown;
    }): Promise<GuestSession>;
  };
  readonly sessions: Pick<GuestSessionStorePort, "resolve">;
  readonly bindings: GuestDiningBindingStorePort;
  readonly credentials: GuestSessionCredentialPort;
  readonly recovery: {
    generate(): GuestRawCredential;
    hash(value: GuestRawCredential): GuestSelectorHash;
  };
  readonly owner: GuestDiningBindingOwnerPort;
  readonly preparationLifetimeSeconds: number;
  readonly now: () => unknown;
}
