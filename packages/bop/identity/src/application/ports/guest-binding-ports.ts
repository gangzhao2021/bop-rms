import type {
  GuestBindingPreparation,
  GuestBindingProof,
  GuestBindingOwnerEvidence,
  completeGuestBinding,
} from "../../contracts/guest-binding-preparation.js";
import type {
  GuestRawCredential,
  GuestSelectorHash,
  GuestSession,
} from "../../contracts/guest-session.js";
import type { CanonicalInstant } from "../../contracts/identity-actor.js";
import type { GuestSessionCredentialPort, GuestSessionStorePort } from "./guest-session-ports.js";

export type GuestBindingCompletion = ReturnType<typeof completeGuestBinding>;

export interface GuestBindingStorePort {
  prepare(record: GuestBindingPreparation, at: CanonicalInstant): Promise<GuestBindingPreparation>;
  acknowledge(input: {
    readonly operationReference: string;
    readonly currentSelectorHash: GuestSelectorHash;
    readonly proof: GuestBindingProof;
    readonly observedAt: CanonicalInstant;
  }): Promise<GuestBindingPreparation>;
  activate(input: {
    readonly operationReference: string;
    readonly currentSelectorHash: GuestSelectorHash;
    readonly proof: GuestBindingProof;
    readonly ownerEvidence: GuestBindingOwnerEvidence;
    readonly observedAt: CanonicalInstant;
  }): Promise<GuestBindingPreparation>;
  complete(input: {
    readonly operationReference: string;
    readonly sessionSelectorHash: GuestSelectorHash;
    readonly csrfSelectorHash: GuestSelectorHash;
    readonly observedAt: CanonicalInstant;
  }): Promise<GuestBindingCompletion>;
}

export interface GuestBindingTargetReceipt {
  readonly operationReference: string;
  readonly targetReference: string;
  readonly sessionReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly expectedVersion: number;
  readonly validUntil: CanonicalInstant;
}

export interface GuestBindingOwnerPort {
  /** Reserve an eligible initial Pickup target, never create a Cart before browser acknowledgement. */
  reserveTarget(input: {
    readonly operationReference: string;
    readonly session: GuestSession;
    readonly observedAt: CanonicalInstant;
  }): Promise<GuestBindingTargetReceipt | null>;
  prepare(input: {
    readonly operationReference: string;
    readonly targetReference: string;
    readonly sessionReference: string;
    readonly predecessorSessionReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly acknowledgedAt: CanonicalInstant;
    readonly validUntil: CanonicalInstant;
    readonly observedAt: CanonicalInstant;
  }): Promise<GuestBindingOwnerEvidence | null>;
  /** Idempotent owner-local activation. Unknown/failure must not report Activated. */
  activate(receipt: GuestBindingCompletion): Promise<"Activated">;
}

export interface GuestBindingServiceOptions {
  readonly authorization: {
    authorize(input: {
      readonly sessionCredential: unknown;
      readonly csrfCredential: unknown;
      readonly observedAt?: unknown;
    }): Promise<GuestSession>;
  };
  readonly sessions: Pick<GuestSessionStorePort, "resolve">;
  readonly bindings: GuestBindingStorePort;
  readonly credentials: GuestSessionCredentialPort;
  readonly recovery: {
    generate(): GuestRawCredential;
    hash(value: GuestRawCredential): GuestSelectorHash;
  };
  readonly owner: GuestBindingOwnerPort;
  readonly preparationLifetimeSeconds: number;
  readonly now: () => unknown;
}
