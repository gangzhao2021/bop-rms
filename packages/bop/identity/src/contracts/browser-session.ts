import {
  createAuthenticationSession,
  parseSessionReference,
  parseSessionVersion,
  type AuthenticationSession,
  type SessionPolicyCode,
  type SessionReference,
  type SessionVersion,
} from "./authentication-session.js";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  type CanonicalInstant,
} from "./identity-actor.js";

export const browserSessionErrorCodes = [
  "BROWSER_SESSION_INPUT_INVALID",
  "BROWSER_SESSION_DENIED",
  "BROWSER_SESSION_VERSION_CONFLICT",
] as const;
export type BrowserSessionErrorCode = (typeof browserSessionErrorCodes)[number];

export class BrowserSessionError extends Error {
  readonly code: BrowserSessionErrorCode;

  constructor(code: BrowserSessionErrorCode) {
    super(
      code === "BROWSER_SESSION_VERSION_CONFLICT" ? "session version conflict" : "request denied",
    );
    this.name = "BrowserSessionError";
    this.code = code;
  }
}

export type RawBrowserCredential = string & {
  readonly __rawBrowserCredential: unique symbol;
};
export type SelectorHash = string & { readonly __selectorHash: unique symbol };
export type AuthorizationTransactionReference = string & {
  readonly __authorizationTransactionReference: unique symbol;
};

export interface EncryptedSecretEnvelope {
  readonly algorithm: "SYNTHETIC_AES_256_GCM" | "KMS_AES_256_GCM";
  readonly keyReference: string;
  readonly ciphertext: string;
  readonly encryptionContext: string;
}

export interface AuthorizationTransaction {
  readonly transactionReference: AuthorizationTransactionReference;
  readonly stateSelectorHash: SelectorHash;
  readonly authCookieSelectorHash: SelectorHash;
  readonly encryptedSecrets: EncryptedSecretEnvelope;
  readonly redirectUri: string;
  readonly postLoginPath: string;
  readonly expiresAt: CanonicalInstant;
  readonly consumedAt: CanonicalInstant | null;
  readonly version: SessionVersion;
}

export interface BrowserSessionRecord {
  readonly session: AuthenticationSession;
  readonly sessionSelectorHash: SelectorHash;
  readonly csrfSelectorHash: SelectorHash;
  readonly encryptedSecrets: EncryptedSecretEnvelope;
}

export interface BrowserSessionConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly allowedPostLoginPaths: readonly string[];
  readonly environment: string;
}

export interface BrowserCookieDescriptor {
  readonly name: "__Host-bop-auth" | "__Host-bop-merchant";
  readonly secure: true;
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly path: "/";
  readonly maxAgeSeconds: number | null;
}

export const authorizationCookie: BrowserCookieDescriptor = Object.freeze({
  name: "__Host-bop-auth",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAgeSeconds: 600,
});

export const merchantSessionCookie: BrowserCookieDescriptor = Object.freeze({
  name: "__Host-bop-merchant",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAgeSeconds: null,
});

const credentialPattern = /^[A-Za-z0-9_-]{43}$/u;
const selectorHashPattern = /^[0-9a-f]{64}$/u;
const safePathPattern = /^\/[A-Za-z0-9/_-]*$/u;

export function parseRawBrowserCredential(value: unknown): RawBrowserCredential {
  if (typeof value !== "string" || !credentialPattern.test(value)) {
    throw new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID");
  }
  return value as RawBrowserCredential;
}

export function parseSelectorHash(value: unknown): SelectorHash {
  if (typeof value !== "string" || !selectorHashPattern.test(value)) {
    throw new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID");
  }
  return value as SelectorHash;
}

export function parseAuthorizationTransactionReference(
  value: unknown,
): AuthorizationTransactionReference {
  try {
    return parseOpaqueUuidV7(
      value,
      "SESSION_REFERENCE_INVALID",
    ) as AuthorizationTransactionReference;
  } catch {
    throw new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID");
  }
}

export function parseExactHttpsUri(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID");
  }
  try {
    const uri = new URL(value);
    if (
      uri.protocol !== "https:" ||
      uri.username ||
      uri.password ||
      uri.hash ||
      uri.origin === "null"
    ) {
      throw new Error("invalid");
    }
    return uri.href;
  } catch {
    throw new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID");
  }
}

export function parsePostLoginPath(value: unknown, allowed: readonly string[]): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !safePathPattern.test(value) ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("%") ||
    !allowed.includes(value)
  ) {
    throw new BrowserSessionError("BROWSER_SESSION_DENIED");
  }
  return value;
}

export function createAuthorizationTransaction(
  input: AuthorizationTransaction,
): AuthorizationTransaction {
  const expiresAt = parseCanonicalInstant(input.expiresAt);
  const consumedAt = input.consumedAt === null ? null : parseCanonicalInstant(input.consumedAt);
  if (consumedAt !== null && Date.parse(consumedAt) > Date.parse(expiresAt)) {
    throw new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID");
  }
  return Object.freeze({
    transactionReference: parseAuthorizationTransactionReference(input.transactionReference),
    stateSelectorHash: parseSelectorHash(input.stateSelectorHash),
    authCookieSelectorHash: parseSelectorHash(input.authCookieSelectorHash),
    encryptedSecrets: Object.freeze({ ...input.encryptedSecrets }),
    redirectUri: parseExactHttpsUri(input.redirectUri),
    postLoginPath: input.postLoginPath,
    expiresAt,
    consumedAt,
    version: parseSessionVersion(input.version),
  });
}

export function createBrowserSessionRecord(input: {
  readonly session: unknown;
  readonly sessionSelectorHash: unknown;
  readonly csrfSelectorHash: unknown;
  readonly encryptedSecrets: EncryptedSecretEnvelope;
}): BrowserSessionRecord {
  if (typeof input.session !== "object" || input.session === null) {
    throw new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID");
  }
  const candidate = input.session as AuthenticationSession;
  const session = createAuthenticationSession({
    sessionReference: candidate.sessionReference,
    actor: candidate.actor,
    status: candidate.status,
    policyCode: candidate.policy?.code,
    maxActiveSessions: candidate.policy?.maxActiveSessions,
    idleTimeoutMinutes: candidate.policy?.idleTimeoutMinutes,
    absoluteTimeoutMinutes: candidate.policy?.absoluteTimeoutMinutes,
    version: candidate.version,
    authenticatedAt: candidate.authenticatedAt,
    createdAt: candidate.createdAt,
    lastSeenAt: candidate.lastSeenAt,
    idleExpiresAt: candidate.idleExpiresAt,
    absoluteExpiresAt: candidate.absoluteExpiresAt,
    rotatedFromSessionReference: candidate.rotatedFromSessionReference,
    revocationReason: candidate.revocationReason,
    revokedAt: candidate.revokedAt,
  });
  return Object.freeze({
    session,
    sessionSelectorHash: parseSelectorHash(input.sessionSelectorHash),
    csrfSelectorHash: parseSelectorHash(input.csrfSelectorHash),
    encryptedSecrets: Object.freeze({ ...input.encryptedSecrets }),
  });
}

export interface IssueBrowserSessionInput {
  readonly sessionReference: SessionReference;
  readonly policyCode: SessionPolicyCode;
  readonly authenticatedAt: CanonicalInstant;
}

export interface RevokeBrowserSessionInput {
  readonly sessionReference: SessionReference;
  readonly expectedVersion: SessionVersion;
  readonly observedAt: CanonicalInstant;
}

export function parseBrowserSessionReference(value: unknown): SessionReference {
  try {
    return parseSessionReference(value);
  } catch {
    throw new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID");
  }
}
