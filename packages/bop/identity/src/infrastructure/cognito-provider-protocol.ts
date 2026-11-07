import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { SimpleJwksCache } from "aws-jwt-verify/jwk";
import * as oidc from "openid-client";
import {
  BrowserSessionError,
  parseAuthorizationTransactionReference,
  parseExactHttpsUri,
  parseRawBrowserCredential,
  parseSelectorHash,
} from "../contracts/browser-session.js";
import { parseCanonicalInstant, readClosedRecord } from "../contracts/identity-actor.js";
import type {
  OidcAuthorizationRequest,
  OidcCodeExchangeRequest,
} from "../application/ports/oidc-provider-port.js";
import type { AuthorizationTransactionReference } from "../contracts/browser-session.js";
import type { CognitoPoolMfaPolicy } from "./cognito-pool-mfa-policy.js";
export interface CognitoProviderConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly managedLoginOrigin: string;
  readonly redirectUri: string;
  readonly logoutReturnUri: string;
}
export interface CognitoProviderProtocolOptions {
  readonly configuration: CognitoProviderConfiguration;
  readonly clock: { now(): string };
  readonly accountKind: "Platform" | "Workforce";
  /**
   * WP-2423 DEC-COGNITO-STORE-STAFF: Workforce sign-in to Store operations (the merchant sign-in
   * and step-up callbacks) instead of Brand administration. Its verified result also carries the
   * signed Cognito username, which names the invited person on a first sign-in.
   */
  readonly profile?: "StoreOperations";
  /**
   * WP-2423 DEC-COGNITO-STORE-STAFF: real Cognito user-pool tokens carry no `acr`/`amr`. With this
   * pool check every authorization and code exchange first needs a recent verified pool setting
   * (MFA required, authenticator app only, password first factor); tokens may then omit
   * `acr`/`amr`, and any that are present must still say loa:4 / password plus one-time code.
   * Without it both claims are required as before.
   */
  readonly poolPolicy?: Pick<CognitoPoolMfaPolicy, "assertRequiredTotp">;
  readonly http?: typeof globalThis.fetch;
}
/** Seconds a signed authentication may be old when its tokens are checked (prompt=login). */
export const cognitoAuthenticationFreshSeconds = 300;
type StrongAuthorizationRequest = OidcAuthorizationRequest & {
  readonly prompt: "login";
  readonly requireTotp: true;
  readonly transactionReference: AuthorizationTransactionReference;
};
type StrongExchangeRequest = OidcCodeExchangeRequest & {
  readonly prompt: "login";
  readonly requireTotp: true;
  readonly transactionReference: AuthorizationTransactionReference;
};
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
const unavailableOrDenied = (error: unknown): never => {
  if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_UNAVAILABLE")
    throw new BrowserSessionError("BROWSER_SESSION_UNAVAILABLE");
  return denied();
};
const strongAmr = ["pwd", "otp", "mfa"];
/** `amr`, when a token carries it, names the password and a one-time code (never anything else). */
const amrStrong = (amr: unknown): boolean =>
  Array.isArray(amr) &&
  amr.length >= 2 &&
  amr.length <= 3 &&
  new Set(amr).size === amr.length &&
  amr.every((value) => strongAmr.includes(value as string)) &&
  amr.includes("pwd") &&
  (amr.includes("otp") || amr.includes("mfa"));
const instant = (value: unknown) => parseCanonicalInstant(value);
const wholeSecond = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= 253402300800
  )
    return denied();
  return value;
};
const credential = (value: unknown, maximum: number): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[\x21-\x7e]+$/u.test(value)
  )
    return denied();
  return value;
};
const configurationKeys = [
  "issuer",
  "clientId",
  "clientSecret",
  "managedLoginOrigin",
  "redirectUri",
  "logoutReturnUri",
] as const;

/** Private fixed two-use wire protocol. Signature/claim validation is shared;
 * only each public owning wrapper resolves its own account kind and MFA proof. */
export function createCognitoProviderProtocol(options: CognitoProviderProtocolOptions) {
  try {
    const o = readClosedRecord(options, [
      "configuration",
      "clock",
      "accountKind",
      ...(Object.hasOwn(options, "profile") ? ["profile"] : []),
      ...(Object.hasOwn(options, "poolPolicy") ? ["poolPolicy"] : []),
      ...(Object.hasOwn(options, "http") ? ["http"] : []),
    ]);
    const poolPolicy = Object.hasOwn(o, "poolPolicy")
      ? (o.poolPolicy as Pick<CognitoPoolMfaPolicy, "assertRequiredTotp"> | undefined)
      : null;
    if (poolPolicy !== null && typeof poolPolicy?.assertRequiredTotp !== "function")
      return denied();
    const assertPool = async () => {
      if (poolPolicy !== null) await poolPolicy.assertRequiredTotp();
    };
    if (o.accountKind !== "Platform" && o.accountKind !== "Workforce") return denied();
    const workforce = o.accountKind === "Workforce";
    const store = Object.hasOwn(o, "profile");
    if (store && (!workforce || o.profile !== "StoreOperations")) return denied();
    const callbackPaths = store
      ? ["/merchant/callback", "/merchant/identity/step-up/callback"]
      : [workforce ? "/merchant/organization/brands/callback" : "/platform/auth/callback"];
    const logoutPath = store
      ? "/app"
      : workforce
        ? "/app/organization/brands"
        : "/platform/tenants";
    const refreshProfile = workforce ? "CognitoWorkforceRefreshV1" : "CognitoPlatformRefreshV1";
    const c = readClosedRecord(o.configuration, configurationKeys);
    const issuer = parseExactHttpsUri(c.issuer),
      managedLoginOrigin = parseExactHttpsUri(c.managedLoginOrigin),
      redirectUri = parseExactHttpsUri(c.redirectUri),
      logoutReturnUri = parseExactHttpsUri(c.logoutReturnUri);
    const pool =
      /^https:\/\/cognito-idp\.ca-central-1\.amazonaws\.com\/(ca-central-1_[A-Za-z0-9]{1,42})$/u.exec(
        issuer,
      )?.[1];
    const login = new URL(managedLoginOrigin),
      callback = new URL(redirectUri),
      logoutReturn = new URL(logoutReturnUri);
    if (
      !pool ||
      issuer !== c.issuer ||
      login.origin !== c.managedLoginOrigin ||
      managedLoginOrigin !== login.origin + "/" ||
      login.port ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(login.hostname) ||
      redirectUri !== c.redirectUri ||
      !callbackPaths.includes(callback.pathname) ||
      callback.search ||
      logoutReturnUri !== c.logoutReturnUri ||
      logoutReturn.origin !== callback.origin ||
      logoutReturn.pathname !== logoutPath ||
      logoutReturn.search ||
      typeof c.clientId !== "string" ||
      !/^[a-z0-9]{1,128}$/u.test(c.clientId)
    )
      return denied();
    const clientId = c.clientId,
      clientSecret = credential(c.clientSecret, 256);
    const clock = readClosedRecord(o.clock, ["now"]),
      now = clock.now,
      http = o.http ?? globalThis.fetch;
    if (typeof now !== "function" || typeof http !== "function") return denied();
    const observe = () => instant(now.call(o.clock));
    const tokenEndpoint = login.origin + "/oauth2/token",
      revocationEndpoint = login.origin + "/oauth2/revoke",
      jwksUri = issuer + "/.well-known/jwks.json";
    // No discovery or token-provided URLs can expand the network allowlist.
    const request: oidc.CustomFetch = async (url, init) => {
      const method = init?.method ?? "GET";
      if (!(
        (url === jwksUri && method === "GET") ||
        ((url === tokenEndpoint || url === revocationEndpoint) && method === "POST")
      ))
        return denied();
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            const response = await http(url, {
              ...init,
              redirect: "error",
              credentials: "omit",
              signal: init?.signal ? AbortSignal.any([abort.signal, init.signal]) : abort.signal,
            });
            if (
              response.redirected ||
              (response.url && response.url !== url) ||
              response.status < 200 ||
              response.status >= 300
            )
              return denied();
            const length = response.headers.get("content-length");
            if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 32768))
              return denied();
            if (
              url !== revocationEndpoint &&
              !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
            )
              return denied();
            const reader = response.body?.getReader(),
              chunks: Uint8Array[] = [];
            let size = 0;
            if (reader) {
              try {
                for (;;) {
                  const part = await reader.read();
                  if (part.done) break;
                  size += part.value.byteLength;
                  if (size > 32768) return denied();
                  chunks.push(part.value);
                }
              } finally {
                await reader.cancel().catch(() => undefined);
              }
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return new Response(size ? bytes : null, {
              status: response.status,
              headers: response.headers,
            });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new BrowserSessionError("BROWSER_SESSION_DENIED"));
            }, 5000);
          }),
        ]);
      } finally {
        abort.abort();
        clearTimeout(timer);
      }
    };
    const sdk = new oidc.Configuration(
      {
        issuer,
        authorization_endpoint: login.origin + "/oauth2/authorize",
        token_endpoint: tokenEndpoint,
        revocation_endpoint: revocationEndpoint,
        jwks_uri: jwksUri,
        id_token_signing_alg_values_supported: ["RS256"],
      },
      clientId,
      { id_token_signed_response_alg: "RS256", [oidc.clockTolerance]: 0 },
      oidc.ClientSecretBasic(clientSecret),
    );
    sdk.timeout = 5;
    sdk[oidc.customFetch] = request;
    const jwksCache = new SimpleJwksCache({
      fetcher: {
        fetch: async (uri) =>
          (
            await request(uri, {
              method: "GET",
              body: undefined,
              headers: { accept: "application/json" },
              redirect: "manual",
            })
          ).arrayBuffer(),
      },
    });
    const idVerifier = CognitoJwtVerifier.create(
      {
        userPoolId: pool,
        tokenUse: "id",
        clientId,
        graceSeconds: 0,
        customJwtCheck: ({ header }) => {
          if (header.alg !== "RS256") return denied();
        },
      },
      { jwksCache },
    );
    const accessVerifier = CognitoJwtVerifier.create(
      {
        userPoolId: pool,
        tokenUse: "access",
        clientId,
        graceSeconds: 0,
        customJwtCheck: ({ header }) => {
          if (header.alg !== "RS256") return denied();
        },
      },
      { jwksCache },
    );
    const fixed = (r: Readonly<Record<string, unknown>>) => {
      if (
        r.issuer !== issuer ||
        r.clientId !== clientId ||
        r.redirectUri !== redirectUri ||
        r.prompt !== "login" ||
        r.requireTotp !== true
      )
        return denied();
      return {
        nonce: parseRawBrowserCredential(r.nonce),
        transactionReference: parseAuthorizationTransactionReference(r.transactionReference),
      };
    };
    const strong = (payload: Readonly<Record<string, unknown>>, observedAt: string) => {
      const auth = wholeSecond(payload.auth_time),
        issued = wholeSecond(payload.iat),
        expires = wholeSecond(payload.exp),
        at = Date.parse(observedAt) / 1000;
      const hasAcr = Object.hasOwn(payload, "acr"),
        hasAmr = Object.hasOwn(payload, "amr");
      if (
        payload.iss !== issuer ||
        typeof payload.sub !== "string" ||
        payload.sub.length > 128 ||
        !/^[\x21-\x7e]+$/u.test(payload.sub) ||
        payload.sub.includes("@") ||
        // Present claims must say strong; absent ones are accepted only behind the pool check.
        (hasAcr && payload.acr !== "urn:cognito:loa:4") ||
        (hasAmr && !amrStrong(payload.amr)) ||
        (poolPolicy === null && (!hasAcr || !hasAmr)) ||
        Object.hasOwn(payload, "identities") ||
        auth > at ||
        issued < auth ||
        issued > at ||
        expires <= at ||
        expires <= issued ||
        at - auth >= cognitoAuthenticationFreshSeconds ||
        at - issued >= cognitoAuthenticationFreshSeconds
      )
        return denied();
      return {
        subject: payload.sub,
        authenticatedAt: instant(new Date(auth * 1000).toISOString()),
      };
    };
    const logout = new URL(login.origin + "/logout");
    logout.searchParams.set("client_id", clientId);
    logout.searchParams.set("logout_uri", logoutReturnUri);
    return Object.freeze({
      async createAuthorizationUrl(value: StrongAuthorizationRequest) {
        try {
          const r = readClosedRecord(value, [
            "issuer",
            "clientId",
            "redirectUri",
            "state",
            "nonce",
            "codeChallenge",
            "codeChallengeMethod",
            "prompt",
            "requireTotp",
            "transactionReference",
          ]);
          const bound = fixed(r);
          if (r.codeChallengeMethod !== "S256") return denied();
          await assertPool();
          return oidc.buildAuthorizationUrl(sdk, {
            redirect_uri: redirectUri,
            response_type: "code",
            scope: "openid",
            state: parseRawBrowserCredential(r.state),
            nonce: bound.nonce,
            code_challenge: parseRawBrowserCredential(r.codeChallenge),
            code_challenge_method: "S256",
            identity_provider: "COGNITO",
            prompt: "login",
            max_age: "0",
            acr_values: "urn:cognito:loa:4",
          }).href;
        } catch (error) {
          return unavailableOrDenied(error);
        }
      },
      async exchangeVerifiedCode(value: StrongExchangeRequest) {
        try {
          const r = readClosedRecord(value, [
            "issuer",
            "clientId",
            "redirectUri",
            "code",
            "nonce",
            "codeVerifier",
            "prompt",
            "requireTotp",
            "transactionReference",
          ]);
          const bound = fixed(r);
          await assertPool();
          const observedAt = observe(),
            callbackUrl = new URL(redirectUri);
          let latest = observedAt;
          const check = () => {
            const at = observe();
            if (at < latest || Date.parse(at) >= Date.parse(observedAt) + 5000) return denied();
            latest = at;
            return at;
          };
          callbackUrl.searchParams.set("code", credential(r.code, 4096));
          // State was consumed and compared by the owning strong Session service.
          // A code-only internal URL does not claim another state observation.
          const tokens = await oidc.authorizationCodeGrant(sdk, callbackUrl, {
            pkceCodeVerifier: parseRawBrowserCredential(r.codeVerifier),
            expectedNonce: bound.nonce,
            idTokenExpected: true,
            maxAge: cognitoAuthenticationFreshSeconds,
          });
          check();
          const idToken = credential(tokens.id_token, 8192),
            accessToken = credential(tokens.access_token, 8192),
            refreshToken = credential(tokens.refresh_token, 6144);
          if (
            tokens.token_type.toLowerCase() !== "bearer" ||
            (tokens.scope !== undefined && tokens.scope !== "openid")
          )
            return denied();
          const idClaims = await idVerifier.verify(idToken);
          check();
          const accessClaims = await accessVerifier.verify(accessToken);
          const checkedAt = check(),
            idBinding = strong(idClaims, checkedAt),
            accessBinding = strong(accessClaims, checkedAt);
          if (
            idClaims.nonce !== bound.nonce ||
            idClaims.aud !== clientId ||
            idClaims.token_use !== "id" ||
            accessClaims.client_id !== clientId ||
            accessClaims.token_use !== "access" ||
            accessClaims.scope !== "openid" ||
            idBinding.subject !== accessBinding.subject ||
            idBinding.authenticatedAt !== accessBinding.authenticatedAt
          )
            return denied();
          const username = idClaims["cognito:username"];
          if (
            store &&
            (typeof username !== "string" ||
              username.length > 128 ||
              !/^[\x21-\x7e]+$/u.test(username))
          )
            return denied();
          return Object.freeze({
            issuer,
            clientId,
            ...idBinding,
            ...(store ? { username: username as string } : {}),
            observedAt: checkedAt,
            nonce: bound.nonce,
            authorizationTransactionReference: bound.transactionReference,
            tokenBundle: JSON.stringify({
              profile: refreshProfile,
              issuer,
              clientId,
              refreshToken,
            }),
            /** Invitation acceptance only. The signed claim proves verification;
             * exact subject/original invitation and approval remain independent.
             * The configured keyed digest producer sees the transient email, but
             * no email or mutable Provider attribute is returned or persisted. */
            assertIntendedEmail(
              expectedDigest: unknown,
              digestCorporateEmail: (email: unknown) => unknown,
            ): void {
              try {
                check();
                const expected = parseSelectorHash(expectedDigest);
                if (
                  !workforce ||
                  idClaims.email_verified !== true ||
                  typeof idClaims.email !== "string" ||
                  idClaims.email.length < 3 ||
                  idClaims.email.length > 254 ||
                  typeof digestCorporateEmail !== "function"
                )
                  return denied();
                const actual = parseSelectorHash(digestCorporateEmail(idClaims.email));
                check();
                if (!timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex")))
                  return denied();
              } catch {
                return denied();
              }
            },
            assertCurrent() {
              const at = check();
              strong(idClaims, at);
              strong(accessClaims, at);
              return at;
            },
          });
        } catch {
          return denied();
        }
      },
      async revokeRefreshTokens(bundle: string): Promise<"confirmed" | "unknown"> {
        try {
          if (typeof bundle !== "string" || bundle.length > 8192) return "unknown";
          const r = readClosedRecord(JSON.parse(bundle), [
            "profile",
            "issuer",
            "clientId",
            "refreshToken",
          ]);
          if (r.profile !== refreshProfile || r.issuer !== issuer || r.clientId !== clientId)
            return "unknown";
          await oidc.tokenRevocation(sdk, credential(r.refreshToken, 6144), {
            token_type_hint: "refresh_token",
          });
          return "confirmed";
        } catch {
          return "unknown";
        }
      },
      createLogoutUrl: () => logout.href,
    });
  } catch {
    return denied();
  }
}
