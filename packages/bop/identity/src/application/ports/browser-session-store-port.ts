import type {
  AuthorizationTransaction,
  BrowserSessionRecord,
  EncryptedSecretEnvelope,
  SelectorHash,
} from "../../contracts/browser-session.js";
import type {
  AuthenticationSession,
  RevocationReason,
  SessionPolicyCode,
  SessionReference,
  SessionVersion,
} from "../../contracts/authentication-session.js";
import type { CanonicalInstant, IdentityActor } from "../../contracts/identity-actor.js";

export interface ConsumeAuthorizationTransactionCommand {
  readonly stateSelectorHash: SelectorHash;
  readonly authCookieSelectorHash: SelectorHash;
  readonly consumedAt: CanonicalInstant;
}

export interface CreateBrowserSessionCommand {
  readonly sessionReference: SessionReference;
  readonly actor: IdentityActor;
  readonly policyCode: SessionPolicyCode;
  readonly sessionSelectorHash: SelectorHash;
  readonly csrfSelectorHash: SelectorHash;
  readonly encryptedSecrets: EncryptedSecretEnvelope;
  readonly observedAt: CanonicalInstant;
}

export interface RotateBrowserSessionCommand {
  readonly currentSelectorHash: SelectorHash;
  readonly expectedVersion: SessionVersion;
  readonly nextSessionReference: SessionReference;
  readonly nextSelectorHash: SelectorHash;
  readonly nextCsrfSelectorHash: SelectorHash;
  readonly nextEncryptedSecrets: EncryptedSecretEnvelope;
  readonly reason:
    | "Login"
    | "MfaCompletion"
    | "PrivilegeElevation"
    | "StoreContextElevation"
    | "Recovery"
    | "RiskChange";
  readonly observedAt: CanonicalInstant;
}

export interface RevokeBrowserSessionCommand {
  readonly selectorHash: SelectorHash;
  readonly expectedVersion: SessionVersion;
  readonly reason: RevocationReason;
  readonly observedAt: CanonicalInstant;
}

export interface BrowserSessionStorePort {
  createAuthorizationTransaction(transaction: AuthorizationTransaction): Promise<void>;
  consumeAuthorizationTransaction(
    command: ConsumeAuthorizationTransactionCommand,
  ): Promise<AuthorizationTransaction | null>;
  createSession(command: CreateBrowserSessionCommand): Promise<BrowserSessionRecord>;
  resolveSession(selectorHash: SelectorHash): Promise<BrowserSessionRecord | null>;
  rotateSession(command: RotateBrowserSessionCommand): Promise<BrowserSessionRecord>;
  revokeSession(command: RevokeBrowserSessionCommand): Promise<AuthenticationSession | null>;
}
