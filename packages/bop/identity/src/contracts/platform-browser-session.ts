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

export const platformAuthorizationCookie = Object.freeze({
  name: "__Host-bop-platform-auth" as const,
  secure: true as const,
  httpOnly: true as const,
  sameSite: "lax" as const,
  path: "/" as const,
  maxAgeSeconds: 600,
});
export const platformSessionCookie = Object.freeze({
  ...platformAuthorizationCookie,
  name: "__Host-bop-platform" as const,
  maxAgeSeconds: null,
});
export interface PlatformBrowserCookieMutation {
  readonly descriptor: typeof platformAuthorizationCookie | typeof platformSessionCookie;
  readonly value: RawBrowserCredential | "";
  readonly clear: boolean;
}

/** Supplied only by a Provider adapter after verifying the fresh TOTP challenge.
 * Second precision preserves the signed whole-second authentication time; its
 * half-open second must overlap or follow the authorization start. Precision is
 * transient and does not extend the persisted MFA expiry.
 * A directory factor-enrollment flag or an unverified token claim is not this evidence. */
export interface PlatformTotpVerification {
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
export interface PlatformOidcProviderPort {
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
    readonly totp: PlatformTotpVerification;
  }>;
  /** Server-side refresh revocation only; this cannot clear the browser's IdP cookie. */
  revokeRefreshTokens(tokenBundle: string): Promise<"confirmed" | "unknown">;
  /** Fixed configured HTTPS managed-login logout URL, with no credential input. */
  createLogoutUrl(): string;
}
export interface PlatformSessionMfa {
  readonly sessionReference: SessionReference;
  readonly actorReference: string;
  readonly method: "Totp";
  readonly evidenceReference: string;
  readonly authorizationTransactionReference: AuthorizationTransactionReference;
  readonly authenticatedAt: CanonicalInstant;
  readonly verifiedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}
export interface PlatformSessionSecrets {
  readonly profile: "PlatformBrowserSessionV1";
  readonly issuer: string;
  readonly clientId: string;
  readonly tokenBundle: string;
  readonly csrf: RawBrowserCredential;
  readonly mfa: PlatformSessionMfa;
}
export interface ReplacePlatformSessionCommand {
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
export interface PlatformBrowserSessionStorePort extends Omit<
  BrowserSessionStorePort,
  "rotateSession"
> {
  replaceAfterStepUp(command: ReplacePlatformSessionCommand): Promise<BrowserSessionRecord>;
}

export const platformSessionDenied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
export function parsePlatformActor(value: unknown): IdentityActor {
  const actor = createIdentityActor(value);
  if (
    actor.actorType !== "User" ||
    actor.accountKind !== "Platform" ||
    actor.authenticationMethod !== "Oidc" ||
    actor.actorReference === null
  )
    return platformSessionDenied();
  return actor;
}
export function platformSessionContext(
  environment: string,
  sessionReference: string,
  actorReference: string,
) {
  return `${environment}:platform-session:${sessionReference}:${actorReference}`;
}
export function platformAuthorizationContext(environment: string, transactionReference: string) {
  return `${environment}:platform-oidc:${transactionReference}`;
}
export function parsePlatformSessionMfa(value: unknown): PlatformSessionMfa {
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
    return platformSessionDenied();
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
export function parsePlatformSessionSecrets(
  value: unknown,
  configuration: Pick<BrowserSessionConfiguration, "issuer" | "clientId">,
  session: AuthenticationSession,
): PlatformSessionSecrets {
  const r = readClosedRecord(value, [
    "profile",
    "issuer",
    "clientId",
    "tokenBundle",
    "csrf",
    "mfa",
  ]);
  const mfa = parsePlatformSessionMfa(r.mfa);
  parsePlatformActor(session.actor);
  if (
    r.profile !== "PlatformBrowserSessionV1" ||
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
    return platformSessionDenied();
  return Object.freeze({
    profile: "PlatformBrowserSessionV1",
    issuer: r.issuer,
    clientId: configuration.clientId,
    tokenBundle: r.tokenBundle,
    csrf: parseRawBrowserCredential(r.csrf),
    mfa,
  });
}
export function assertPlatformSessionCurrent(
  session: AuthenticationSession,
  mfa: PlatformSessionMfa,
  observedAtInput: unknown,
  requireRecentMfa = true,
): CanonicalInstant {
  const observedAt = parseCanonicalInstant(observedAtInput);
  assertSessionUsable(session, observedAt);
  parsePlatformActor(session.actor);
  if (
    session.policy.code !== "Privileged" ||
    mfa.sessionReference !== session.sessionReference ||
    mfa.actorReference !== session.actor.actorReference ||
    mfa.authenticatedAt !== session.authenticatedAt ||
    session.lastSeenAt > observedAt ||
    mfa.verifiedAt > observedAt ||
    (requireRecentMfa && observedAt >= mfa.validUntil)
  )
    return platformSessionDenied();
  return observedAt;
}
