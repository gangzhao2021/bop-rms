import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createIdentityActor,
  parseCanonicalInstant,
  parseRawBrowserCredential,
  parseSelectorHash,
  type OidcAuthorizationTransaction,
  type PlatformOidcProviderPort,
  type SessionEnvelopeCryptoPort,
} from "@bop/identity";
import {
  createPlatformAuthenticationRuntime,
  createCognitoPlatformAuthenticationRuntime,
  type CognitoPlatformAuthenticationRuntimeOptions,
  type PlatformAuthenticationRuntimeOptions,
} from "./platform-authentication-runtime.js";

const id = (n: number) => `01902627-0010-7000-8000-${n.toString(16).padStart(12, "0")}`;
const initial = "2026-10-06T12:00:00.000Z";
type Row = Record<string, unknown>;
const millis = (value: unknown) => (value instanceof Date ? value.getTime() : NaN);
const hex = (value: unknown) => {
  if (!(value instanceof Uint8Array)) throw new Error("synthetic bytes absent");
  return Buffer.from(value).toString("hex");
};

/** Actual Identity service and PostgreSQL store, with a controlled SQL transport,
 * local AES-GCM and synthetic Provider/directory. Not external identity evidence. */
function fixture() {
  const state = {
    at: initial,
    actorActive: true,
    actorKind: "Platform",
    proof: true,
    lag: 0,
    failInsert: false,
    expireDuringWrite: false,
    postCommitDelay: false,
    logout: "confirmed" as "confirmed" | "unknown",
    authorizationUrl: "https://identity.invalid/authorize",
  };
  let credentials = 1,
    reference = 20,
    nonce = 1,
    proof = 500;
  let authorizations = new Map<string, Row>(),
    sessions = new Map<string, Row>();
  const requests: Parameters<PlatformOidcProviderPort["createAuthorizationUrl"]>[0][] = [];
  const key = Buffer.alloc(32, 41);
  const envelopes: SessionEnvelopeCryptoPort = {
    async encrypt(plaintext, encryptionContext) {
      const iv = Buffer.alloc(12, nonce++),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(encryptionContext));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "synthetic-only",
        ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url"),
        encryptionContext,
      };
    },
    async decrypt(envelope, context) {
      if (context !== envelope.encryptionContext) throw new Error("synthetic AAD mismatch");
      const packed = Buffer.from(envelope.ciphertext, "base64url"),
        cipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(packed.subarray(12, 28));
      return Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
  const currentActor = vi.fn(
    async (
      actual: OidcAuthorizationTransaction,
      actorReference: string,
      authenticatedAt: string,
    ) => {
      expect(actual).toBe(tx);
      if (!state.actorActive) throw new Error("synthetic directory withdrawal");
      return createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: state.actorKind,
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt,
        recentMfaAt: null,
      });
    },
  );
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    if (sql.startsWith("LOCK TABLE")) return { rows: [] };
    if (sql.startsWith("INSERT INTO bop_identity.oidc_authorization_transaction")) {
      authorizations.set(String(values[1]), {
        transaction_id: values[0],
        state_selector_hash: Buffer.from(String(values[1]), "hex"),
        auth_cookie_selector_hash: Buffer.from(String(values[2]), "hex"),
        encrypted_secret: values[3],
        cipher_algorithm: values[4],
        key_reference: values[5],
        encryption_context: values[6],
        redirect_uri: values[7],
        post_login_path: values[8],
        created_at: new Date(String(values[9])),
        expires_at: new Date(String(values[10])),
        consumed_at: null,
        version: 1,
      });
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE bop_identity.oidc_authorization_transaction")) {
      const row = authorizations.get(String(values[0]));
      if (
        !row ||
        hex(row.auth_cookie_selector_hash) !== values[1] ||
        row.consumed_at !== null ||
        millis(row.created_at) > Date.parse(String(values[2])) ||
        millis(row.expires_at) <= Date.parse(String(values[2]))
      )
        return { rows: [] };
      row.consumed_at = new Date(String(values[2]));
      row.version = 2;
      return { rows: [row] };
    }
    if (sql.startsWith("SELECT * FROM bop_identity.authentication_session")) {
      const row = sessions.get(String(values[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("SELECT session_id,created_at"))
      return {
        rows: [...sessions.values()]
          .filter(
            (r) =>
              r.actor_id === values[0] &&
              r.status === "Active" &&
              millis(r.idle_expires_at) > Date.parse(String(values[1])),
          )
          .sort((a, b) => millis(a.created_at) - millis(b.created_at))
          .map((r) => ({ ...r, exact_created_at: true })),
      };
    if (sql.startsWith("INSERT INTO bop_identity.authentication_session")) {
      if (state.failInsert) throw new Error("synthetic insert failure");
      sessions.set(String(values[2]), {
        session_id: values[0],
        actor_id: values[1],
        session_selector_hash: Buffer.from(String(values[2]), "hex"),
        csrf_selector_hash: Buffer.from(String(values[3]), "hex"),
        policy_code: values[4],
        status: "Active",
        encrypted_secret: values[5],
        cipher_algorithm: values[6],
        key_reference: values[7],
        encryption_context: values[8],
        authenticated_at: new Date(String(values[9])),
        created_at: new Date(String(values[10])),
        last_seen_at: new Date(String(values[11])),
        idle_expires_at: new Date(String(values[12])),
        absolute_expires_at: new Date(String(values[13])),
        rotated_from_session_id: values[14],
        version: values[15],
        revocation_reason: null,
        revoked_at: null,
      });
      if (state.expireDuringWrite) state.at = new Date(Date.parse(state.at) + 5000).toISOString();
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE bop_identity.authentication_session SET status='Revoked'")) {
      const row = [...sessions.values()].find((r) => r.session_id === values[0]);
      if (!row) throw new Error("synthetic session absent");
      row.status = "Revoked";
      row.version = Number(row.version) + 1;
      row.revocation_reason = sql.includes("ConcurrentLimit")
        ? "ConcurrentLimit"
        : sql.includes("RiskChange")
          ? "RiskChange"
          : values[1];
      row.revoked_at = new Date(String(values[sql.includes("revocation_reason=$2") ? 2 : 1]));
      return { rows: [] };
    }
    throw new Error("unexpected synthetic SQL");
  });
  const tx: OidcAuthorizationTransaction = { query };
  const transactions = {
    async run<T>(work: (actual: OidcAuthorizationTransaction) => Promise<T>): Promise<T> {
      const previousSessions = structuredClone(sessions),
        previousAuthorizations = structuredClone(authorizations);
      try {
        const result = await work(tx);
        if (state.postCommitDelay && sessions.size > previousSessions.size)
          state.at = new Date(Date.parse(state.at) + 6000).toISOString();
        return result;
      } catch (error) {
        sessions = previousSessions;
        authorizations = previousAuthorizations;
        throw error;
      }
    },
  };
  const provider: PlatformOidcProviderPort = {
    createAuthorizationUrl: vi.fn(async (request) => {
      requests.push(request);
      return state.authorizationUrl;
    }),
    exchangeCode: vi.fn(async (request) => {
      const authenticatedAt = parseCanonicalInstant(state.at),
        verifiedAt = parseCanonicalInstant(
          new Date(Date.parse(state.at) - state.lag).toISOString(),
        );
      const result = {
        actor: createIdentityActor({
          actorType: "User",
          actorReference: id(1),
          accountKind: "Platform",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "RecentMfa",
          authenticatedAt,
          recentMfaAt: verifiedAt,
        }),
        tokenBundle: "synthetic-provider-secret",
        totp: {
          method: "Totp" as const,
          timestampPrecision: "Millisecond" as const,
          evidenceReference: id(proof++),
          actorReference: id(1),
          issuer: request.issuer,
          clientId: request.clientId,
          authorizationTransactionReference: request.transactionReference,
          nonce: request.nonce,
          authenticatedAt,
          verifiedAt,
        },
      };
      if (!state.proof) Reflect.deleteProperty(result, "totp");
      return result;
    }),
    revokeRefreshTokens: vi.fn(async () => state.logout),
    createLogoutUrl: () =>
      "https://identity.invalid/logout?client_id=synthetic-platform&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Ftenants",
  };
  const options: PlatformAuthenticationRuntimeOptions = {
    exactOrigin: "https://platform.invalid",
    acceptedHost: "platform.invalid",
    authorizationOrigin: "https://identity.invalid",
    logoutUrl:
      "https://identity.invalid/logout?client_id=synthetic-platform&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Ftenants",
    transactions,
    currentActor,
    now: () => state.at,
    identity: {
      configuration: {
        environment: "synthetic",
        issuer: "https://identity.invalid/",
        clientId: "synthetic-platform",
        redirectUri: "https://platform.invalid/platform/auth/callback",
        allowedPostLoginPaths: ["/platform/tenants"],
      },
      provider,
      envelopes,
      hasher: {
        hash: (value) =>
          parseSelectorHash(createHmac("sha256", Buffer.alloc(32, 51)).update(value).digest("hex")),
        equals: (a, b) => a === b,
      },
      credentials: {
        generate: () =>
          parseRawBrowserCredential(Buffer.alloc(32, credentials++).toString("base64url")),
        generateUuidV7: () => id(reference++),
      },
      pkce: { challenge: (value) => createHash("sha256").update(value).digest("base64url") },
    },
  };
  const runtime = createPlatformAuthenticationRuntime(options);
  const callback = async (authCookie: string) => {
    const request = requests.at(-1);
    if (!request) throw new Error("synthetic request absent");
    return runtime.service.callback({ code: "synthetic-code", state: request.state, authCookie });
  };
  const login = async () => {
    const started = await runtime.service.start("/platform/tenants");
    // A controlled Provider challenge can finish after start; its proof must
    // never predate this actual one-time authorization transaction.
    if (state.lag > 0) state.at = new Date(Date.parse(state.at) + state.lag).toISOString();
    const result = await callback(started.cookie.value),
      cookie = result.cookies[1]?.value;
    if (!cookie) throw new Error("synthetic session cookie absent");
    return { result, cookie, bootstrap: await runtime.service.bootstrap(cookie) };
  };
  return {
    options,
    runtime,
    state,
    requests,
    provider,
    query,
    currentActor,
    callback,
    login,
    rows: () => [...sessions.values()],
  };
}

function cognitoStartupOptions(
  f: ReturnType<typeof fixture>,
): CognitoPlatformAuthenticationRuntimeOptions {
  return {
    configuration: {
      environment: "synthetic",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
      clientId: "syntheticplatformclient",
      clientSecret: "synthetic-startup-only-secret",
      managedLoginOrigin: "https://synthetic.auth.ca-central-1.amazoncognito.com",
      redirectUri: "https://platform.invalid/platform/auth/callback",
      logoutReturnUri: "https://platform.invalid/platform/tenants",
    },
    transactions: f.options.transactions,
    registerBeforeCommit: vi.fn(),
    clock: { now: f.options.now },
    hasher: f.options.identity.hasher,
    envelopes: f.options.identity.envelopes,
    credentials: f.options.identity.credentials,
    pkce: f.options.identity.pkce,
    exactOrigin: f.options.exactOrigin,
    acceptedHost: f.options.acceptedHost,
  };
}

it("starts actual Cognito composition with encrypted authorization state and fixed privileged challenge", async () => {
  const f = fixture(),
    options = cognitoStartupOptions(f),
    runtime = createCognitoPlatformAuthenticationRuntime(options);
  const started = await runtime.service.start("/platform/tenants"),
    target = new URL(started.authorizationUrl);
  expect(target.origin).toBe(options.configuration.managedLoginOrigin);
  expect(target.pathname).toBe("/oauth2/authorize");
  expect(Object.fromEntries(target.searchParams)).toMatchObject({
    client_id: options.configuration.clientId,
    redirect_uri: options.configuration.redirectUri,
    response_type: "code",
    prompt: "login",
    code_challenge_method: "S256",
    acr_values: "urn:cognito:loa:4",
    max_age: "0",
  });
  expect(target.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(target.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(started.cookie.descriptor.name).toBe("__Host-bop-platform-auth");
  expect(
    f.query.mock.calls.some(([sql]) =>
      sql.startsWith("INSERT INTO bop_identity.oidc_authorization_transaction"),
    ),
  ).toBe(true);
  expect(f.requests).toHaveLength(0);
  expect(f.currentActor).not.toHaveBeenCalled();
  expect(f.rows()).toHaveLength(0);
  expect(started.authorizationUrl).not.toContain(options.configuration.clientSecret);
  expect(runtime.logoutUrl).toBe(
    "https://synthetic.auth.ca-central-1.amazoncognito.com/logout?client_id=syntheticplatformclient&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Ftenants",
  );
});

it("rejects unconfigured or contradictory concrete startup without substituting identity verdicts", () => {
  const options = cognitoStartupOptions(fixture());
  const candidates = [
    { ...options, acceptedHost: "other.invalid" },
    {
      ...options,
      configuration: { ...options.configuration, issuer: "https://identity.invalid/" },
    },
    {
      ...options,
      configuration: {
        ...options.configuration,
        logoutReturnUri: "https://other.invalid/platform/tenants",
      },
    },
  ];
  for (const candidate of candidates)
    expect(() => createCognitoPlatformAuthenticationRuntime(candidate)).toThrow(
      "PLATFORM_AUTHENTICATION_RUNTIME_UNAVAILABLE",
    );
  for (const key of [
    "credentials",
    "pkce",
    "envelopes",
    "hasher",
    "registerBeforeCommit",
  ] as const) {
    const candidate = { ...options };
    Reflect.deleteProperty(candidate, key);
    expect(() => createCognitoPlatformAuthenticationRuntime(candidate)).toThrow(
      "PLATFORM_AUTHENTICATION_RUNTIME_UNAVAILABLE",
    );
  }
});

it("composes real Platform owners, retains same transaction identity, and completes login/expired-MFA stepup/logout", async () => {
  const f = fixture();
  f.state.lag = 60_000;
  const first = await f.login();
  expect(f.runtime.clock.now()).toBe("2026-10-06T12:01:00.000Z");
  expect(first.bootstrap.recentMfa.verifiedAt).toBe(initial);
  expect(Object.isFrozen(f.runtime)).toBe(true);
  expect(Object.keys(f.runtime.service).sort()).toEqual([
    "bootstrap",
    "callback",
    "logout",
    "start",
    "startStepUp",
  ]);
  expect(f.requests[0]).toMatchObject({
    prompt: "login",
    requireTotp: true,
    redirectUri: "https://platform.invalid/platform/auth/callback",
    codeChallengeMethod: "S256",
  });
  expect(first.result.cookies.map((c) => c.descriptor.name)).toEqual([
    "__Host-bop-platform-auth",
    "__Host-bop-platform",
  ]);
  expect(first.result.session.actor.accountKind).toBe("Platform");
  expect(first.result.session.policy.code).toBe("Privileged");
  expect(first.bootstrap.recentMfaRequired).toBe(false);
  expect(f.rows()[0]?.encryption_context).toContain(":platform-session:");
  expect(f.currentActor).toHaveBeenCalled();
  f.state.at = first.bootstrap.recentMfa.validUntil;
  expect((await f.runtime.service.bootstrap(first.cookie)).recentMfaRequired).toBe(true);
  f.state.lag = 0;
  const step = await f.runtime.service.startStepUp({
      sessionCookie: first.cookie,
      csrf: first.bootstrap.csrf,
      postLoginPath: "/platform/tenants",
    }),
    replacement = await f.callback(step.cookie.value),
    nextCookie = replacement.cookies[1]?.value;
  expect(replacement.session.sessionReference).not.toBe(first.result.session.sessionReference);
  expect(replacement.session.rotatedFromSessionReference).toBe(
    first.result.session.sessionReference,
  );
  await expect(f.runtime.service.bootstrap(first.cookie)).rejects.toMatchObject({
    code: "BROWSER_SESSION_DENIED",
  });
  const next = await f.runtime.service.bootstrap(nextCookie);
  f.state.logout = "unknown";
  expect(await f.runtime.service.logout({ sessionCookie: nextCookie, csrf: next.csrf })).toEqual({
    status: "Unknown",
    cookies: [],
    browserLogoutUrl: null,
  });
  f.state.logout = "confirmed";
  expect(
    await f.runtime.service.logout({ sessionCookie: nextCookie, csrf: next.csrf }),
  ).toMatchObject({
    status: "BrowserLogoutRequired",
    browserLogoutUrl: f.options.logoutUrl,
    cookies: [{ clear: true, value: "", descriptor: { name: "__Host-bop-platform" } }],
  });
});
it("keeps actual directory, fresh TOTP and old Session rollback authoritative", async () => {
  const stale = fixture();
  stale.state.lag = 60_000;
  const staleStart = await stale.runtime.service.start("/platform/tenants");
  await expect(stale.callback(staleStart.cookie.value)).rejects.toMatchObject({
    code: "BROWSER_SESSION_DENIED",
  });
  expect(stale.rows()).toEqual([]);
  const missing = fixture();
  missing.state.proof = false;
  await expect(missing.login()).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
  expect(missing.rows()).toEqual([]);
  const foreign = fixture();
  foreign.state.actorKind = "Workforce";
  await expect(foreign.login()).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
  expect(foreign.rows()).toEqual([]);
  const f = fixture(),
    original = await f.login();
  f.state.failInsert = true;
  const step = await f.runtime.service.startStepUp({
    sessionCookie: original.cookie,
    csrf: original.bootstrap.csrf,
    postLoginPath: "/platform/tenants",
  });
  await expect(f.callback(step.cookie.value)).rejects.toMatchObject({
    code: "BROWSER_SESSION_DENIED",
  });
  expect(
    f.query.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT INTO bop_identity.authentication_session"),
    ),
  ).toHaveLength(2);
  expect((await f.runtime.service.bootstrap(original.cookie)).session.status).toBe("Active");
  f.state.actorActive = false;
  await expect(f.runtime.service.bootstrap(original.cookie)).rejects.toMatchObject({
    code: "BROWSER_SESSION_DENIED",
  });
});
it("preserves the owning write deadline and does not introduce a post-COMMIT clock rejection", async () => {
  const expired = fixture();
  expired.state.expireDuringWrite = true;
  await expect(expired.login()).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
  expect(expired.rows()).toEqual([]);
  const committed = fixture();
  committed.state.postCommitDelay = true;
  expect((await committed.login()).result.session.status).toBe("Active");
  expect(committed.rows()).toHaveLength(1);
});
it.each([
  "https://foreign.invalid/authorize",
  "//identity.invalid/authorize",
  "http://identity.invalid/authorize",
  "https://identity.invalid@foreign.invalid/authorize",
])("refuses a Provider redirect outside the configured HTTPS origin (%s)", async (url) => {
  const f = fixture();
  f.state.authorizationUrl = url;
  await expect(f.runtime.service.start("/platform/tenants")).rejects.toMatchObject({
    code: "BROWSER_SESSION_DENIED",
  });
  expect(f.provider.exchangeCode).not.toHaveBeenCalled();
});
it("refuses incompatible startup origins, callback, destinations and missing mandatory ports", () => {
  const f = fixture(),
    original = f.options;
  const candidates = [
    { ...original, exactOrigin: "http://platform.invalid" },
    { ...original, acceptedHost: "foreign.invalid" },
    { ...original, authorizationOrigin: "https://identity.invalid/authorize" },
    {
      ...original,
      identity: {
        ...original.identity,
        configuration: {
          ...original.identity.configuration,
          redirectUri: "https://platform.invalid/callback",
        },
      },
    },
    {
      ...original,
      identity: {
        ...original.identity,
        configuration: {
          ...original.identity.configuration,
          allowedPostLoginPaths: ["/platform/tenants", "/platform/other"],
        },
      },
    },
  ];
  for (const options of candidates)
    expect(() => createPlatformAuthenticationRuntime(options)).toThrow(
      "PLATFORM_AUTHENTICATION_RUNTIME_UNAVAILABLE",
    );
  for (const key of ["provider", "envelopes", "hasher", "credentials", "pkce"] as const) {
    const identity = { ...original.identity };
    Reflect.deleteProperty(identity, key);
    expect(() => createPlatformAuthenticationRuntime({ ...original, identity })).toThrow(
      "PLATFORM_AUTHENTICATION_RUNTIME_UNAVAILABLE",
    );
  }
  const missing = { ...original };
  Reflect.deleteProperty(missing, "currentActor");
  expect(() => createPlatformAuthenticationRuntime(missing)).toThrow(
    "PLATFORM_AUTHENTICATION_RUNTIME_UNAVAILABLE",
  );
  expect(f.query).not.toHaveBeenCalled();
});
it("binds the closed Provider logout URL to the exact configured client and browser return", () => {
  const f = fixture(),
    logoutUrl = f.options.logoutUrl;
  for (const url of [
    logoutUrl.replace("client_id=synthetic-platform", "client_id=another-client"),
    logoutUrl.replace("platform.invalid", "foreign.invalid"),
    logoutUrl.replace("/logout?", "/other?"),
    `${logoutUrl}&client_id=synthetic-platform`,
    `${logoutUrl}&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Ftenants`,
    `${logoutUrl}&state=unexpected`,
  ])
    expect(() => createPlatformAuthenticationRuntime({ ...f.options, logoutUrl: url })).toThrow(
      "PLATFORM_AUTHENTICATION_RUNTIME_UNAVAILABLE",
    );
  expect(f.query).not.toHaveBeenCalled();
  expect(f.provider.exchangeCode).not.toHaveBeenCalled();
});

it("keeps template administration absent unless concrete Cognito startup explicitly enables it", () => {
  const f = fixture(),
    options = cognitoStartupOptions(f);
  expect(createCognitoPlatformAuthenticationRuntime(options)).not.toHaveProperty(
    "templateAdministration",
  );
  expect(
    createCognitoPlatformAuthenticationRuntime({ ...options, enableTemplateAdministration: false }),
  ).not.toHaveProperty("templateAdministration");
  const enabled = createCognitoPlatformAuthenticationRuntime({
    ...options,
    enableTemplateAdministration: true,
  });
  expect(Object.isFrozen(enabled.templateAdministration)).toBe(true);
  expect(Object.keys(enabled.templateAdministration ?? {}).sort()).toEqual(["command", "query"]);
  expect(createPlatformAuthenticationRuntime(f.options)).not.toHaveProperty(
    "templateAdministration",
  );
});
it("explicitly enabled administration still requires actual persisted Platform Session and CSRF", async () => {
  const f = fixture(),
    runtime = createCognitoPlatformAuthenticationRuntime({
      ...cognitoStartupOptions(f),
      enableTemplateAdministration: true,
    });
  const administration = runtime.templateAdministration;
  if (!administration) throw new Error("selected administration unavailable");
  await expect(
    administration.query({
      sessionCookie: Buffer.alloc(32, 60).toString("base64url"),
      csrf: Buffer.alloc(32, 61).toString("base64url"),
      request: { action: "List", after: null, limit: 20 },
    }),
  ).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
  expect(
    f.query.mock.calls.some(
      ([sql]) => sql.includes("bop_permission") || sql.includes("platform_brand_template_revision"),
    ),
  ).toBe(false);
});
