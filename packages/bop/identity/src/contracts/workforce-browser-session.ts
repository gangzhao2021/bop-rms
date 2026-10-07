import {
  assertSessionUsable,
  parseSessionReference,
  type AuthenticationSession,
  type SessionReference,
  type SessionVersion,
} from "./authentication-session.js";
import {
  BrowserSessionError,
  parseAuthorizationTransactionReference,
  parseExactHttpsUri,
  parseRawBrowserCredential,
  type AuthorizationTransactionReference,
  type BrowserSessionConfiguration,
  type BrowserSessionRecord,
  type EncryptedSecretEnvelope,
  type RawBrowserCredential,
  type SelectorHash,
} from "./browser-session.js";
import {
  createIdentityActor,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
  type CanonicalInstant,
  type IdentityActor,
} from "./identity-actor.js";
import type { BrowserSessionStorePort } from "../application/ports/browser-session-store-port.js";
import type {
  OidcAuthorizationRequest,
  OidcCodeExchangeRequest,
} from "../application/ports/oidc-provider-port.js";

// Fixed privileged Workforce browser entry. This does not confer a Brand or Store role.
export const workforceAuthorizationCookie = Object.freeze({
  name: "__Host-bop-auth" as const,
  secure: true as const,
  httpOnly: true as const,
  sameSite: "lax" as const,
  path: "/" as const,
  maxAgeSeconds: 600,
});
export const workforceSessionCookie = Object.freeze({
  ...workforceAuthorizationCookie,
  name: "__Host-bop-merchant" as const,
  maxAgeSeconds: null,
});
export interface WorkforceBrowserCookieMutation {
  readonly descriptor: typeof workforceAuthorizationCookie | typeof workforceSessionCookie;
  readonly value: RawBrowserCredential | "";
  readonly clear: boolean;
}

/** Supplied only by a Provider adapter after verifying the fresh TOTP challenge.
 * Second precision preserves the signed whole-second authentication time; its
 * half-open second must overlap or follow the authorization start. Precision is
 * transient and does not extend the persisted MFA expiry.
 * A directory factor-enrollment flag or an unverified token claim is not this evidence. */
export interface WorkforceTotpVerification {
  readonly method: "Totp";
  readonly timestampPrecision: "Second" | "Millisecond";
  readonly evidenceReference: string;
  readonly actorReference: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly authorizationTransactionReference: AuthorizationTransactionReference;
  readonly nonce: RawBrowserCredential;
  readonly authenticatedAt: CanonicalInstant;
  readonly verifiedAt: CanonicalInstant;
}
export interface WorkforceOidcProviderPort {
  createAuthorizationUrl(
    request: OidcAuthorizationRequest & {
      readonly prompt: "login";
      readonly requireTotp: true;
      readonly transactionReference: AuthorizationTransactionReference;
    },
  ): Promise<string>;
  exchangeCode(
    request: OidcCodeExchangeRequest & {
      readonly prompt: "login";
      readonly requireTotp: true;
      readonly transactionReference: AuthorizationTransactionReference;
    },
  ): Promise<{
    readonly actor: IdentityActor;
    readonly tokenBundle: string;
    readonly totp: WorkforceTotpVerification;
  }>;
  /** Server-side refresh revocation only; this cannot clear the browser's IdP cookie. */
  revokeRefreshTokens(tokenBundle: string): Promise<"confirmed" | "unknown">;
  /** Fixed configured HTTPS managed-login logout URL, with no credential input. */
  createLogoutUrl(): string;
}
export interface WorkforceSessionMfa {
  readonly sessionReference: SessionReference;
  readonly actorReference: string;
  readonly method: "Totp";
  readonly evidenceReference: string;
  readonly authorizationTransactionReference: AuthorizationTransactionReference;
  readonly authenticatedAt: CanonicalInstant;
  readonly verifiedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}
export interface WorkforceSessionSecrets {
  readonly profile: "WorkforceBrowserSessionV1";
  readonly issuer: string;
  readonly clientId: string;
  readonly tokenBundle: string;
  readonly csrf: RawBrowserCredential;
  readonly mfa: WorkforceSessionMfa;
}
export interface ReplaceWorkforceSessionCommand {
  readonly currentSelectorHash: SelectorHash;
  readonly expectedSessionReference: SessionReference;
  readonly expectedVersion: SessionVersion;
  readonly nextSessionReference: SessionReference;
  readonly actor: IdentityActor;
  readonly nextSelectorHash: SelectorHash;
  readonly nextCsrfSelectorHash: SelectorHash;
  readonly nextEncryptedSecrets: EncryptedSecretEnvelope;
  readonly observedAt: CanonicalInstant;
}
export interface WorkforceBrowserSessionStorePort extends Omit<
  BrowserSessionStorePort,
  "rotateSession"
> {
  replaceAfterStepUp(command: ReplaceWorkforceSessionCommand): Promise<BrowserSessionRecord>;
}

export const workforceSessionDenied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
export function parseWorkforceActor(value: unknown): IdentityActor {
  const actor = createIdentityActor(value);
  if (
    actor.actorType !== "User" ||
    actor.accountKind !== "Workforce" ||
    actor.authenticationMethod !== "Oidc" ||
    actor.actorReference === null
  )
    return workforceSessionDenied();
  return actor;
}
export function workforceSessionContext(
  environment: string,
  sessionReference: string,
  actorReference: string,
) {
  return `${environment}:session:${sessionReference}:${actorReference}`;
}
export function workforceAuthorizationContext(environment: string, transactionReference: string) {
  return `${environment}:oidc:${transactionReference}`;
}
export function parseWorkforceSessionMfa(value: unknown): WorkforceSessionMfa {
  const r = readClosedRecord(value, [
    "sessionReference",
    "actorReference",
    "method",
    "evidenceReference",
    "authorizationTransactionReference",
    "authenticatedAt",
    "verifiedAt",
    "validUntil",
  ]);
  const verifiedAt = parseCanonicalInstant(r.verifiedAt),
    authenticatedAt = parseCanonicalInstant(r.authenticatedAt),
    validUntil = parseCanonicalInstant(r.validUntil);
  if (
    r.method !== "Totp" ||
    verifiedAt > authenticatedAt ||
    Date.parse(validUntil) !== Date.parse(verifiedAt) + 900_000
  )
    return workforceSessionDenied();
  return Object.freeze({
    sessionReference: parseSessionReference(r.sessionReference),
    actorReference: parseOpaqueUuidV7(r.actorReference, "ACTOR_REFERENCE_INVALID"),
    method: "Totp",
    evidenceReference: parseOpaqueUuidV7(r.evidenceReference, "ACTOR_REFERENCE_INVALID"),
    authorizationTransactionReference: parseAuthorizationTransactionReference(
      r.authorizationTransactionReference,
    ),
    authenticatedAt,
    verifiedAt,
    validUntil,
  });
}
/** Identity-internal encrypted payload parser. This payload is never a browser response. */
export function parseWorkforceSessionSecrets(
  value: unknown,
  configuration: Pick<BrowserSessionConfiguration, "issuer" | "clientId">,
  session: AuthenticationSession,
): WorkforceSessionSecrets {
  const r = readClosedRecord(value, [
    "profile",
    "issuer",
    "clientId",
    "tokenBundle",
    "csrf",
    "mfa",
  ]);
  const mfa = parseWorkforceSessionMfa(r.mfa);
  parseWorkforceActor(session.actor);
  if (
    r.profile !== "WorkforceBrowserSessionV1" ||
    r.issuer !== configuration.issuer ||
    parseExactHttpsUri(r.issuer) !== configuration.issuer ||
    r.clientId !== configuration.clientId ||
    typeof r.tokenBundle !== "string" ||
    r.tokenBundle.length < 1 ||
    r.tokenBundle.length > 8192 ||
    session.policy.code !== "Privileged" ||
    mfa.sessionReference !== session.sessionReference ||
    mfa.actorReference !== session.actor.actorReference ||
    mfa.authenticatedAt !== session.authenticatedAt ||
    mfa.authenticatedAt > session.createdAt
  )
    return workforceSessionDenied();
  return Object.freeze({
    profile: "WorkforceBrowserSessionV1",
    issuer: r.issuer,
    clientId: configuration.clientId,
    tokenBundle: r.tokenBundle,
    csrf: parseRawBrowserCredential(r.csrf),
    mfa,
  });
}
export function assertWorkforceSessionCurrent(
  session: AuthenticationSession,
  mfa: WorkforceSessionMfa,
  observedAtInput: unknown,
  requireRecentMfa = true,
): CanonicalInstant {
  const observedAt = parseCanonicalInstant(observedAtInput);
  assertSessionUsable(session, observedAt);
  parseWorkforceActor(session.actor);
  if (
    session.policy.code !== "Privileged" ||
    mfa.sessionReference !== session.sessionReference ||
    mfa.actorReference !== session.actor.actorReference ||
    mfa.authenticatedAt !== session.authenticatedAt ||
    session.lastSeenAt > observedAt ||
    mfa.verifiedAt > observedAt ||
    (requireRecentMfa && observedAt >= mfa.validUntil)
  )
    return workforceSessionDenied();
  return observedAt;
}
