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

/**
 * WP-2423 Q18: genuine staff activity on a Session (or, with `extend: false`, a read of its
 * deadlines). The store checks the bound CSRF selector and, when extending, slides the idle
 * deadline (bounded by the absolute deadline) at most once per write interval. Activity is
 * advisory: when the row is busy the write is skipped, never failed. Errors are
 * `BROWSER_SESSION_ENDED` (revoked, expired, unknown), `BROWSER_SESSION_DENIED` (CSRF mismatch) or
 * `BROWSER_SESSION_UNAVAILABLE` (transient; retry later).
 */
export interface RecordBrowserSessionActivityCommand {
  readonly selectorHash: SelectorHash;
  readonly csrfSelectorHash: SelectorHash;
  readonly observedAt: CanonicalInstant;
  readonly extend: boolean;
}

export interface BrowserSessionActivityResult {
  readonly session: AuthenticationSession;
  readonly recorded: boolean;
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
  /** Optional: stores without sliding idle expiry keep the deadline fixed at creation. */
  recordActivity?(
    command: RecordBrowserSessionActivityCommand,
  ): Promise<BrowserSessionActivityResult>;
}
