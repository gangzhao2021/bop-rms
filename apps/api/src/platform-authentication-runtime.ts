import {
  BrowserSessionError,
  PlatformBrowserSessionService,
  createCognitoPlatformIdentity,
  createPostgresPlatformBrowserSessionStore,
  parseExactHttpsUri,
  type CognitoPlatformIdentityOptions,
  type PlatformBrowserSessionServiceOptions,
} from "@bop/identity";
import {
  createPlatformTemplateAdministration,
  type PlatformTemplateAdministration,
} from "./platform-template-administration.js";
import type { PlatformAuthenticationHttpOptions } from "./platform-authentication-http.js";

type Persistence = Parameters<typeof createPostgresPlatformBrowserSessionStore>[0];
export interface PlatformAuthenticationRuntimeOptions {
  readonly identity: Omit<PlatformBrowserSessionServiceOptions, "store" | "now">;
  readonly transactions: Persistence["transactions"];
  readonly currentActor: Persistence["currentActor"];
  readonly now: () => string;
  readonly exactOrigin: string;
  readonly acceptedHost: string;
  readonly authorizationOrigin: string;
  readonly logoutUrl: string;
}
export interface CognitoPlatformAuthenticationRuntimeOptions extends Omit<
  CognitoPlatformIdentityOptions,
  "nextEvidenceReference"
> {
  readonly credentials: PlatformBrowserSessionServiceOptions["credentials"];
  readonly pkce: PlatformBrowserSessionServiceOptions["pkce"];
  readonly enableTemplateAdministration?: boolean;
  readonly exactOrigin: string;
  readonly acceptedHost: string;
}
const unavailable = (): never => {
  throw new Error("PLATFORM_AUTHENTICATION_RUNTIME_UNAVAILABLE");
};
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};

/** Fixed production composition: Identity owns the actual Provider, remote status
 * and persisted directory. Startup supplies configuration and infrastructure only. */
export function createCognitoPlatformAuthenticationRuntime(
  options: CognitoPlatformAuthenticationRuntimeOptions,
): PlatformAuthenticationHttpOptions & {
  readonly templateAdministration?: PlatformTemplateAdministration;
} {
  try {
    if (
      options.enableTemplateAdministration !== undefined &&
      typeof options.enableTemplateAdministration !== "boolean"
    )
      return unavailable();
    const credentials = options.credentials,
      allocate = credentials.generateUuidV7.bind(credentials),
      clock = options.clock,
      now = clock.now.bind(clock),
      c = options.configuration;
    const actual = createCognitoPlatformIdentity({
      configuration: c,
      transactions: options.transactions,
      registerBeforeCommit: options.registerBeforeCommit,
      clock,
      hasher: options.hasher,
      envelopes: options.envelopes,
      nextEvidenceReference: allocate,
    });
    const configured = buildPlatformAuthenticationRuntime({
      identity: {
        configuration: {
          environment: c.environment,
          issuer: c.issuer,
          clientId: c.clientId,
          redirectUri: c.redirectUri,
          allowedPostLoginPaths: ["/platform/tenants"],
        },
        provider: actual.provider,
        credentials,
        hasher: options.hasher,
        envelopes: options.envelopes,
        pkce: options.pkce,
      },
      transactions: actual.transactions,
      currentActor: actual.currentActor,
      now,
      exactOrigin: options.exactOrigin,
      acceptedHost: options.acceptedHost,
      authorizationOrigin: c.managedLoginOrigin,
      logoutUrl: actual.provider.createLogoutUrl(),
    });
    if (!options.enableTemplateAdministration) return configured.http;
    const templateAdministration = createPlatformTemplateAdministration({
      authentication: configured.service,
      persistence: {
        transactions: actual.transactions,
        currentActor: actual.currentActor,
        now,
        environment: c.environment,
        issuer: c.issuer,
        clientId: c.clientId,
        redirectUri: c.redirectUri,
        allowedPostLoginPaths: ["/platform/tenants"],
        hasher: options.hasher,
        envelopes: options.envelopes,
      },
      registerBeforeCommit: options.registerBeforeCommit,
      nextReference: allocate,
    });
    return Object.freeze({ ...configured.http, templateAdministration });
  } catch {
    return unavailable();
  }
}

/** Authentication-only startup composition. All Provider, directory, crypto and
 * transaction ports are mandatory; no Platform permission or Tenant is inferred. */
export function createPlatformAuthenticationRuntime(
  options: PlatformAuthenticationRuntimeOptions,
): PlatformAuthenticationHttpOptions {
  return buildPlatformAuthenticationRuntime(options).http;
}
function buildPlatformAuthenticationRuntime(options: PlatformAuthenticationRuntimeOptions) {
  try {
    const origin = new URL(options.exactOrigin),
      providerOrigin = new URL(options.authorizationOrigin),
      identity = options.identity,
      c = identity.configuration,
      logoutDestination = new URL(parseExactHttpsUri(options.logoutUrl)),
      logoutParameters = logoutDestination.searchParams;
    if (
      origin.protocol !== "https:" ||
      origin.origin !== options.exactOrigin ||
      origin.host !== options.acceptedHost ||
      providerOrigin.protocol !== "https:" ||
      providerOrigin.origin !== options.authorizationOrigin ||
      parseExactHttpsUri(options.logoutUrl) !== options.logoutUrl ||
      logoutDestination.origin !== options.authorizationOrigin ||
      logoutDestination.pathname !== "/logout" ||
      [...logoutParameters.keys()].length !== 2 ||
      logoutParameters.getAll("client_id").length !== 1 ||
      logoutParameters.getAll("logout_uri").length !== 1 ||
      logoutParameters.get("client_id") !== c.clientId ||
      logoutParameters.get("logout_uri") !== `${options.exactOrigin}/platform/tenants` ||
      c.redirectUri !== `${origin.origin}/platform/auth/callback` ||
      c.allowedPostLoginPaths.length !== 1 ||
      c.allowedPostLoginPaths[0] !== "/platform/tenants" ||
      typeof options.transactions?.run !== "function" ||
      typeof options.currentActor !== "function" ||
      typeof options.now !== "function"
    )
      return unavailable();
    const configuration = Object.freeze({
      ...c,
      allowedPostLoginPaths: Object.freeze(["/platform/tenants"]),
    });
    const clock = options.now.bind(options),
      currentActor = options.currentActor.bind(options),
      provider = identity.provider,
      createAuthorizationUrl = provider.createAuthorizationUrl.bind(provider),
      exchangeCode = provider.exchangeCode.bind(provider),
      revokeRefreshTokens = provider.revokeRefreshTokens.bind(provider),
      createLogoutUrl = provider.createLogoutUrl.bind(provider),
      authorizationOrigin = options.authorizationOrigin,
      logoutUrl = options.logoutUrl;
    const store = createPostgresPlatformBrowserSessionStore({
      transactions: options.transactions,
      currentActor,
      now: clock,
      environment: configuration.environment,
      issuer: configuration.issuer,
      clientId: configuration.clientId,
      redirectUri: configuration.redirectUri,
      allowedPostLoginPaths: configuration.allowedPostLoginPaths,
      hasher: identity.hasher,
      envelopes: identity.envelopes,
    });
    const service = new PlatformBrowserSessionService({
      ...identity,
      configuration,
      now: clock,
      store,
      provider: Object.freeze({
        async createAuthorizationUrl(
          request: Parameters<
            PlatformBrowserSessionServiceOptions["provider"]["createAuthorizationUrl"]
          >[0],
        ) {
          const value = parseExactHttpsUri(await createAuthorizationUrl(request));
          if (new URL(value).origin !== authorizationOrigin) return denied();
          return value;
        },
        exchangeCode,
        revokeRefreshTokens,
        createLogoutUrl() {
          const value = parseExactHttpsUri(createLogoutUrl());
          if (value !== logoutUrl) return denied();
          return value;
        },
      }),
    });
    const http = Object.freeze({
      exactOrigin: options.exactOrigin,
      acceptedHost: options.acceptedHost,
      authorizationOrigin,
      logoutUrl,
      service: Object.freeze({
        start: service.start.bind(service),
        callback: service.callback.bind(service),
        bootstrap: service.bootstrap.bind(service),
        startStepUp: service.startStepUp.bind(service),
        logout: service.logout.bind(service),
      }),
      clock: Object.freeze({ now: clock }),
    });
    return Object.freeze({ http, service });
  } catch {
    return unavailable();
  }
}
