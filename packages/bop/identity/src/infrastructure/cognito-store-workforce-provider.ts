import {
  BrowserSessionError,
  parseAuthorizationTransactionReference,
} from "../contracts/browser-session.js";
import {
  createIdentityActor,
  parseCanonicalInstant,
  readClosedRecord,
  type IdentityActor,
} from "../contracts/identity-actor.js";
import type {
  OidcAuthorizationRequest,
  OidcCodeExchangeRequest,
  OidcProviderPort,
} from "../application/ports/oidc-provider-port.js";
import {
  createCognitoProviderProtocol,
  type CognitoProviderConfiguration,
} from "./cognito-provider-protocol.js";
import {
  createCognitoPoolMfaPolicy,
  type CognitoPoolMfaPolicy,
  type CognitoPoolMfaPolicyOptions,
} from "./cognito-pool-mfa-policy.js";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF: the Store staff sign-in (ordinary `WorkforceStandard` and
 * kitchen display sessions with the existing session continuity rules) over the shared Cognito
 * wire protocol: managed login with the authorization code flow, PKCE, `prompt=login` and the
 * authenticator (TOTP) every time. The signed subject and username are resolved by the caller
 * (an existing account, or the first sign-in of an invited person); the result is never a grant.
 * Step-up uses the same protocol on its own callback: the staff member signs in again with their
 * authenticator and the caller records the fresh authentication for their current session.
 *
 * Real Cognito tokens carry no `acr`/`amr`: both sign-in and step-up first need a recent check that
 * the pool requires the authenticator app (`pool`, see `createCognitoPoolMfaPolicy`), and the signed
 * `auth_time` must fall after the authorization was started (`authorizationStartedAt`, at most
 * `authenticationSkewMs` earlier) and within five minutes of the callback.
 */
export interface CognitoStoreWorkforceProviderOptions {
  /** `redirectUri` is `<origin>/merchant/callback`; `logoutReturnUri` is `<origin>/app`. */
  readonly configuration: CognitoProviderConfiguration;
  /** `<origin>/merchant/identity/step-up/callback`, registered on the same app client. */
  readonly stepUpRedirectUri: string;
  readonly clock: { now(): string };
  readonly nextReference: () => string;
  readonly resolveSubject: (input: CognitoStoreVerifiedSubject) => Promise<IdentityActor>;
  /** TEST-ONLY: the loopback Cognito stand-in answering the pool check (InternalTest only). */
  readonly providerEndpoint?: CognitoPoolMfaPolicyOptions["providerEndpoint"];
  readonly http?: typeof globalThis.fetch;
}
export interface CognitoStoreVerifiedSubject {
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly username: string;
  readonly authenticatedAt: string;
  readonly observedAt: string;
}
export interface CognitoStoreWorkforceProvider extends OidcProviderPort {
  /** The pool's MFA check: refresh at startup and every few minutes (`monitor`), and its status. */
  readonly pool: Pick<CognitoPoolMfaPolicy, "refresh" | "status" | "monitor">;
  readonly stepUp: {
    readonly redirectUri: string;
    createAuthorizationUrl(request: OidcAuthorizationRequest): Promise<string>;
    /** The verified fresh authentication; its refresh token is revoked at once (not kept). */
    verify(request: OidcCodeExchangeRequest): Promise<CognitoStoreVerifiedSubject>;
  };
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
const rethrowUnavailable = (error: unknown): never => {
  if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_UNAVAILABLE")
    throw new BrowserSessionError("BROWSER_SESSION_UNAVAILABLE");
  return denied();
};
/** How much earlier than the authorization start Cognito's clock may date the sign-in. */
export const authenticationSkewMs = 10_000;
const protocolKeys = [
  "issuer",
  "clientId",
  "clientSecret",
  "managedLoginOrigin",
  "redirectUri",
  "logoutReturnUri",
] as const;

export function createCognitoStoreWorkforceProvider(
  options: CognitoStoreWorkforceProviderOptions,
): CognitoStoreWorkforceProvider {
  try {
    const o = readClosedRecord(options, [
      "configuration",
      "stepUpRedirectUri",
      "clock",
      "nextReference",
      "resolveSubject",
      ...(Object.hasOwn(options, "providerEndpoint") ? ["providerEndpoint"] : []),
      ...(Object.hasOwn(options, "http") ? ["http"] : []),
    ]);
    const configuration = readClosedRecord(
      o.configuration,
      protocolKeys,
    ) as unknown as CognitoProviderConfiguration;
    const resolve = o.resolveSubject,
      next = o.nextReference;
    if (typeof resolve !== "function" || typeof next !== "function") return denied();
    const userPoolId =
      /^https:\/\/cognito-idp\.ca-central-1\.amazonaws\.com\/(ca-central-1_[A-Za-z0-9]{1,42})$/u.exec(
        configuration.issuer,
      )?.[1];
    if (!userPoolId) return denied();
    const poolPolicy = createCognitoPoolMfaPolicy({
      userPoolId,
      clock: options.clock,
      ...(options.providerEndpoint === undefined
        ? {}
        : { providerEndpoint: options.providerEndpoint }),
    });
    const shared = {
      clock: options.clock,
      accountKind: "Workforce" as const,
      profile: "StoreOperations" as const,
      poolPolicy,
      ...(options.http === undefined ? {} : { http: options.http }),
    };
    const login = createCognitoProviderProtocol({
      ...shared,
      configuration: Object.freeze({ ...configuration }),
    });
    const stepUpRedirectUri = String(o.stepUpRedirectUri);
    if (
      new URL(stepUpRedirectUri).origin !== new URL(configuration.redirectUri).origin ||
      stepUpRedirectUri === configuration.redirectUri
    )
      return denied();
    const reauthentication = createCognitoProviderProtocol({
      ...shared,
      configuration: Object.freeze({ ...configuration, redirectUri: stepUpRedirectUri }),
    });
    const transaction = () => parseAuthorizationTransactionReference(next());
    const verified = async (
      protocol: typeof login,
      request: OidcCodeExchangeRequest,
    ): Promise<{
      readonly subject: CognitoStoreVerifiedSubject;
      readonly tokenBundle: string;
      readonly assertCurrent: () => string;
    }> => {
      const { authorizationStartedAt, ...exchange } = readClosedRecord(request, [
        "issuer",
        "clientId",
        "redirectUri",
        "code",
        "nonce",
        "codeVerifier",
        "authorizationStartedAt",
      ]);
      const startedAt = Date.parse(parseCanonicalInstant(authorizationStartedAt));
      const result = await protocol.exchangeVerifiedCode({
        ...exchange,
        prompt: "login",
        requireTotp: true,
        transactionReference: transaction(),
      } as Parameters<typeof protocol.exchangeVerifiedCode>[0]);
      const username = (result as { readonly username?: unknown }).username;
      if (typeof username !== "string") return denied();
      // prompt=login/max_age=0: the password and authenticator were entered for this request,
      // not reused from an earlier Cognito sign-in (auth_time is whole seconds).
      if (Date.parse(result.authenticatedAt) + 1000 <= startedAt - authenticationSkewMs)
        return denied();
      return {
        subject: Object.freeze({
          issuer: result.issuer,
          clientId: result.clientId,
          subject: result.subject,
          username,
          authenticatedAt: parseCanonicalInstant(result.authenticatedAt),
          observedAt: parseCanonicalInstant(result.observedAt),
        }),
        tokenBundle: result.tokenBundle,
        assertCurrent: () => result.assertCurrent(),
      };
    };
    return Object.freeze({
      async createAuthorizationUrl(request: OidcAuthorizationRequest) {
        try {
          return await login.createAuthorizationUrl({
            ...request,
            prompt: "login",
            requireTotp: true,
            transactionReference: transaction(),
          });
        } catch (error) {
          return rethrowUnavailable(error);
        }
      },
      async exchangeCode(request: OidcCodeExchangeRequest) {
        try {
          const result = await verified(login, request);
          const actor = createIdentityActor(await resolve(result.subject));
          result.assertCurrent();
          if (
            actor.actorReference === null ||
            actor.accountKind !== "Workforce" ||
            actor.actorType !== "User" ||
            actor.authenticationMethod !== "Oidc" ||
            actor.authenticatedAt !== result.subject.authenticatedAt
          )
            return denied();
          return Object.freeze({ actor, tokenBundle: result.tokenBundle });
        } catch {
          return denied();
        }
      },
      async revokeOrLogout(tokenBundle: string) {
        return login.revokeRefreshTokens(tokenBundle);
      },
      pool: Object.freeze({
        refresh: poolPolicy.refresh,
        status: poolPolicy.status,
        monitor: poolPolicy.monitor,
      }),
      stepUp: Object.freeze({
        redirectUri: stepUpRedirectUri,
        async createAuthorizationUrl(request: OidcAuthorizationRequest) {
          try {
            return await reauthentication.createAuthorizationUrl({
              ...request,
              prompt: "login",
              requireTotp: true,
              transactionReference: transaction(),
            });
          } catch (error) {
            return rethrowUnavailable(error);
          }
        },
        async verify(request: OidcCodeExchangeRequest) {
          try {
            const result = await verified(reauthentication, request);
            // A re-authentication proves presence only; it never keeps a refresh token.
            await reauthentication.revokeRefreshTokens(result.tokenBundle).catch(() => undefined);
            result.assertCurrent();
            return result.subject;
          } catch {
            return denied();
          }
        },
      }),
    });
  } catch {
    return denied();
  }
}
