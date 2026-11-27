import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentityActor } from "../contracts/identity-actor.js";
import {
  BrowserSessionError,
  parseAuthorizationTransactionReference,
} from "../contracts/browser-session.js";
import {
  createCognitoPlatformProvider,
  type CognitoPlatformProviderOptions,
} from "../infrastructure/cognito-platform-provider.js";

// Local RSA keys, signed JWTs and HTTP responses are synthetic. Both installed
// verification libraries run unchanged; no verifier or signature result is mocked.
const idKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const accessKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
  clientId: "syntheticplatformclient",
  clientSecret: "synthetic-confidential-client-secret",
  managedLoginOrigin: "https://synthetic.auth.ca-central-1.amazoncognito.com",
  redirectUri: "https://app.example.test/platform/auth/callback",
  logoutReturnUri: "https://app.example.test/platform/tenants",
};
const subject = "11111111-2222-4333-8444-555555555555";
const actorReference = "01902627-0300-7000-8000-000000000001";
const evidenceReference = "01902627-0300-7000-8000-000000000002";
const transactionReference = parseAuthorizationTransactionReference(
  "01902627-0300-7000-8000-000000000003",
);
const request = {
  issuer: config.issuer,
  clientId: config.clientId,
  redirectUri: config.redirectUri,
  nonce: "n".repeat(43),
  codeVerifier: "v".repeat(43),
  code: "synthetic/code\\with%characters",
  prompt: "login" as const,
  requireTotp: true as const,
  transactionReference,
};
const authorizeRequest = () => ({
  issuer: config.issuer,
  clientId: config.clientId,
  redirectUri: config.redirectUri,
  nonce: request.nonce,
  state: "s".repeat(43),
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256" as const,
  prompt: "login" as const,
  requireTotp: true as const,
  transactionReference,
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (
  claims: Record<string, unknown>,
  use: "id" | "access",
  badSignature = false,
  alg = "RS256",
) => {
  const body = `${encode({ alg, kid: use + "-key", typ: "JWT" })}.${encode(claims)}`;
  const key = badSignature
    ? strangerKey.privateKey
    : use === "id"
      ? idKey.privateKey
      : accessKey.privateKey;
  return (
    body +
    "." +
    sign(alg === "RS512" ? "RSA-SHA512" : "RSA-SHA256", Buffer.from(body), key).toString(
      "base64url",
    )
  );
};
function fixture() {
  const second = Math.floor(Date.now() / 1000);
  let at = new Date(Date.now()).toISOString();
  const common = {
    iss: config.issuer,
    sub: subject,
    auth_time: second,
    iat: second,
    exp: second + 3600,
    acr: "urn:cognito:loa:4",
    amr: ["pwd", "otp", "mfa"],
  };
  const claims = {
    id: {
      ...common,
      token_use: "id",
      aud: config.clientId,
      nonce: request.nonce,
      email: "synthetic-unused@example.test",
      "cognito:groups": ["ignored-not-a-grant"],
    },
    access: { ...common, token_use: "access", client_id: config.clientId, scope: "openid" },
  };
  const changes: {
    id: Record<string, unknown>;
    access: Record<string, unknown>;
    badSignature: "id" | "access" | null;
    algorithm: "id" | "access" | null;
    response: Record<string, unknown>;
    tokenNetwork: (() => Response | Promise<Response>) | null;
    jwksNetwork: (() => Response | Promise<Response>) | null;
    revokeNetwork: (() => Response | Promise<Response>) | null;
  } = {
    id: {},
    access: {},
    badSignature: null,
    algorithm: null,
    response: {},
    tokenNetwork: null,
    jwksNetwork: null,
    revokeNetwork: null,
  };
  const calls: { url: string; init: Parameters<typeof globalThis.fetch>[1] }[] = [];
  const http = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === config.issuer + "/.well-known/jwks.json") {
      if (changes.jwksNetwork) return changes.jwksNetwork();
      return Response.json({
        keys: [
          { ...idKey.publicKey.export({ format: "jwk" }), kid: "id-key", use: "sig", alg: "RS256" },
          {
            ...accessKey.publicKey.export({ format: "jwk" }),
            kid: "access-key",
            use: "sig",
            alg: "RS256",
          },
        ],
      });
    }
    if (url === config.managedLoginOrigin + "/oauth2/token") {
      if (changes.tokenNetwork) return changes.tokenNetwork();
      return Response.json({
        access_token: jwt(
          { ...claims.access, ...changes.access },
          "access",
          changes.badSignature === "access",
          changes.algorithm === "access" ? "RS512" : "RS256",
        ),
        id_token: jwt(
          { ...claims.id, ...changes.id },
          "id",
          changes.badSignature === "id",
          changes.algorithm === "id" ? "RS512" : "RS256",
        ),
        refresh_token: "synthetic-only-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid",
        ...changes.response,
      });
    }
    if (url === config.managedLoginOrigin + "/oauth2/revoke")
      return changes.revokeNetwork ? changes.revokeNetwork() : new Response(null, { status: 200 });
    throw new Error("UNEXPECTED_TEST_ENDPOINT");
  });

  const resolveVerifiedSubject = vi.fn<CognitoPlatformProviderOptions["resolveVerifiedSubject"]>(
    async ({ authenticatedAt }) =>
      createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Platform",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        recentMfaAt: null,
        authenticatedAt,
      }),
  );
  const nextEvidenceReference = vi.fn(() => evidenceReference);
  const options: CognitoPlatformProviderOptions = {
    configuration: { ...config },
    clock: { now: () => at },
    nextEvidenceReference,
    resolveVerifiedSubject,
    http,
  };
  return {
    options,
    changes,
    calls,
    http,
    resolveVerifiedSubject,
    nextEvidenceReference,
    second,
    setClock: (next: string) => {
      at = next;
    },
    create: () => createCognitoPlatformProvider(options),
  };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("Cognito Platform Provider", () => {
  it("keeps the Platform refresh envelope distinct from Workforce after protocol reuse", async () => {
    const f = fixture(),
      provider = f.create(),
      result = await provider.exchangeCode(request);
    const bundle = JSON.parse(result.tokenBundle);
    expect(bundle.profile).toBe("CognitoPlatformRefreshV1");
    expect(
      await provider.revokeRefreshTokens(
        JSON.stringify({ ...bundle, profile: "CognitoWorkforceRefreshV1" }),
      ),
    ).toBe("unknown");
    expect(f.calls.some((call) => call.url.endsWith("/oauth2/revoke"))).toBe(false);
  });
  it("passes a verified opaque subject only to the directory and never derives an Actor reference from it", async () => {
    const f = fixture(),
      opaque = "synthetic_native_subject-opaque";
    f.changes.id.sub = opaque;
    f.changes.access.sub = opaque;
    const result = await f.create().exchangeCode(request);
    expect(f.resolveVerifiedSubject).toHaveBeenCalledWith(
      expect.objectContaining({ subject: opaque }),
    );
    expect(result.actor.actorReference).toBe(actorReference);
    expect(result.totp.actorReference).toBe(actorReference);
    expect(result.tokenBundle).not.toContain(opaque);
  });
  it("uses fixed native Cognito login and actual confidential PKCE grant, verifies both signatures, then binds the named Actor", async () => {
    const f = fixture(),
      provider = f.create(),
      url = new URL(await provider.createAuthorizationUrl(authorizeRequest()));
    expect(url.origin + url.pathname).toBe(config.managedLoginOrigin + "/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: config.redirectUri,
      scope: "openid",
      state: "s".repeat(43),
      nonce: request.nonce,
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      identity_provider: "COGNITO",
      prompt: "login",
      max_age: "0",
      acr_values: "urn:cognito:loa:4",
    });
    expect(f.http).not.toHaveBeenCalled();
    const result = await provider.exchangeCode(request),
      authenticatedAt = new Date(f.second * 1000).toISOString();
    expect(f.resolveVerifiedSubject).toHaveBeenCalledExactlyOnceWith({
      issuer: config.issuer,
      clientId: config.clientId,
      subject,
      authenticatedAt,
      observedAt: f.options.clock.now(),
    });
    expect(f.nextEvidenceReference).toHaveBeenCalledOnce();
    expect(result.actor).toEqual(
      createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Platform",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "RecentMfa",
        authenticatedAt,
        recentMfaAt: authenticatedAt,
      }),
    );
    expect(result.totp).toEqual({
      method: "Totp",
      timestampPrecision: "Second",
      actorReference,
      evidenceReference,
      issuer: config.issuer,
      clientId: config.clientId,
      authorizationTransactionReference: transactionReference,
      nonce: request.nonce,
      authenticatedAt,
      verifiedAt: authenticatedAt,
    });
    expect(JSON.parse(result.tokenBundle)).toEqual({
      profile: "CognitoPlatformRefreshV1",
      issuer: config.issuer,
      clientId: config.clientId,
      refreshToken: "synthetic-only-refresh-token",
    });
    expect(result.tokenBundle).not.toMatch(
      /email|groups|id_token|access_token|nonce|clientSecret/u,
    );
    const tokenCall = f.calls.find((c) => c.url.endsWith("/oauth2/token"));
    expect(tokenCall?.init?.redirect).toBe("error");
    expect(tokenCall?.init?.credentials).toBe("omit");
    const body = new URLSearchParams(String(tokenCall?.init?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: config.redirectUri,
      code_verifier: request.codeVerifier,
    });
    const basic = new Headers(tokenCall?.init?.headers).get("authorization");
    if (!basic?.startsWith("Basic ")) throw new Error("Expected Basic client authentication");
    expect(
      Buffer.from(basic.slice(6), "base64").toString("utf8").split(":").map(decodeURIComponent),
    ).toEqual([config.clientId, config.clientSecret]);
    expect(
      f.calls.every((c) =>
        [
          config.managedLoginOrigin + "/oauth2/token",
          config.issuer + "/.well-known/jwks.json",
        ].includes(c.url),
      ),
    ).toBe(true);
    const logout = new URL(provider.createLogoutUrl());
    expect(logout.origin + logout.pathname).toBe(config.managedLoginOrigin + "/logout");
    expect(Object.fromEntries(logout.searchParams)).toEqual({
      client_id: config.clientId,
      logout_uri: config.logoutReturnUri,
    });
  });

  it.each([
    ["id signature", "id", {}, "signature"],
    ["access signature", "access", {}, "signature"],
    ["id algorithm", "id", {}, "algorithm"],
    ["access algorithm", "access", {}, "algorithm"],
    ["id nonce", "id", { nonce: "wrong" }, "claim"],
    ["id audience", "id", { aud: "otherclient" }, "claim"],
    ["access client", "access", { client_id: "otherclient" }, "claim"],
    [
      "id issuer",
      "id",
      { iss: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Other" },
      "claim",
    ],
    [
      "access issuer",
      "access",
      { iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other" },
      "claim",
    ],
    ["id use", "id", { token_use: "access" }, "claim"],
    ["access use", "access", { token_use: "id" }, "claim"],
    ["different subject", "access", { sub: "11111111-2222-4333-8444-666666666666" }, "claim"],
    ["email instead of subject", "id", { sub: "synthetic@example.test" }, "claim"],
    ["id lower assurance", "id", { acr: "urn:cognito:loa:3" }, "claim"],
    ["access lower assurance", "access", { acr: "urn:cognito:loa:3" }, "claim"],
    ["missing TOTP", "id", { amr: ["pwd", "sms", "mfa"] }, "claim"],
    ["unsupported method", "access", { amr: ["pwd", "otp", "mfa", "fed"] }, "claim"],
    ["duplicated method", "id", { amr: ["pwd", "otp", "otp"] }, "claim"],
    [
      "federated identities",
      "id",
      { identities: [{ providerName: "SyntheticFederation" }] },
      "claim",
    ],
    ["access scope", "access", { scope: "openid other" }, "claim"],
  ] as const)(
    "refuses %s before directory/evidence allocation with a generic error",
    async (_, use, changes, mode) => {
      const f = fixture();
      Object.assign(f.changes[use], changes);
      if (mode === "signature") f.changes.badSignature = use;
      if (mode === "algorithm") f.changes.algorithm = use;
      await expect(f.create().exchangeCode(request)).rejects.toEqual(
        new BrowserSessionError("BROWSER_SESSION_DENIED"),
      );
      expect(f.resolveVerifiedSubject).not.toHaveBeenCalled();
      expect(f.nextEvidenceReference).not.toHaveBeenCalled();
    },
  );

  it.each([
    "expired id",
    "expired access",
    "future auth",
    "future issuance",
    "old auth",
    "different auth",
    "fractional auth",
  ])("rejects signed %s without changing the Provider timestamp", async (mode) => {
    const f = fixture();
    if (mode === "expired id") f.changes.id.exp = f.second - 1;
    if (mode === "expired access") f.changes.access.exp = f.second - 1;
    if (mode === "future auth") f.changes.id.auth_time = f.second + 1;
    if (mode === "future issuance") f.changes.access.iat = f.second + 1;
    if (mode === "old auth") f.changes.id.auth_time = f.second - 601;
    if (mode === "different auth") f.changes.access.auth_time = f.second - 1;
    if (mode === "fractional auth") f.changes.id.auth_time = f.second - 0.5;
    await expect(f.create().exchangeCode(request)).rejects.toEqual(
      new BrowserSessionError("BROWSER_SESSION_DENIED"),
    );
    expect(f.resolveVerifiedSubject).not.toHaveBeenCalled();
    expect(f.nextEvidenceReference).not.toHaveBeenCalled();
  });

  it.each(["unknown", "workforce", "wrong time", "directory MFA", "clock expired"])(
    "rejects %s directory results after cryptographic verification",
    async (mode) => {
      const f = fixture();
      f.resolveVerifiedSubject.mockImplementation(async ({ authenticatedAt }) => {
        if (mode === "unknown") throw new Error("SYNTHETIC_UNKNOWN_SUBJECT");
        if (mode === "clock expired")
          f.setClock(new Date(Date.parse(f.options.clock.now()) + 5000).toISOString());
        return createIdentityActor({
          actorType: "User",
          actorReference,
          accountKind: mode === "workforce" ? "Workforce" : "Platform",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: mode === "directory MFA" ? "RecentMfa" : "SingleFactor",
          recentMfaAt: mode === "directory MFA" ? authenticatedAt : null,
          authenticatedAt:
            mode === "wrong time"
              ? new Date(Date.parse(authenticatedAt) - 1000).toISOString()
              : authenticatedAt,
        });
      });
      await expect(f.create().exchangeCode(request)).rejects.toEqual(
        new BrowserSessionError("BROWSER_SESSION_DENIED"),
      );
      expect(f.resolveVerifiedSubject).toHaveBeenCalledOnce();
      expect(f.nextEvidenceReference).not.toHaveBeenCalled();
    },
  );

  it("rejects untrusted startup configuration and closed request extras before network access", async () => {
    const f = fixture();
    for (const change of [
      { issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic" },
      { managedLoginOrigin: "http://synthetic.example.test" },
      { managedLoginOrigin: config.managedLoginOrigin + "/other" },
      { managedLoginOrigin: "//synthetic.example.test" },
      { managedLoginOrigin: "https://user:secret@synthetic.example.test" },
      { redirectUri: "https://app.example.test/other" },
      { redirectUri: config.redirectUri + "?extra=1" },
      { logoutReturnUri: "https://other.example.test/platform/tenants" },
      { clientId: "" },
      { clientSecret: "" },
      { extra: "untrusted" },
    ])
      expect(() =>
        createCognitoPlatformProvider({ ...f.options, configuration: { ...config, ...change } }),
      ).toThrow(BrowserSessionError);
    const provider = f.create();
    await expect(
      Reflect.apply(provider.createAuthorizationUrl, undefined, [
        { ...authorizeRequest(), prompt: "none" },
      ]),
    ).rejects.toThrow(BrowserSessionError);
    await expect(
      Reflect.apply(provider.createAuthorizationUrl, undefined, [
        { ...authorizeRequest(), identity_provider: "Federation" },
      ]),
    ).rejects.toThrow(BrowserSessionError);
    await expect(
      Reflect.apply(provider.exchangeCode, undefined, [{ ...request, state: "unconsumed" }]),
    ).rejects.toThrow(BrowserSessionError);
    await expect(provider.exchangeCode({ ...request, codeVerifier: "short" })).rejects.toThrow(
      BrowserSessionError,
    );
    expect(f.http).not.toHaveBeenCalled();
  });

  it("uses the actual 55-character Cognito pool bound", () => {
    const f = fixture(),
      prefix = "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_";
    expect(() =>
      createCognitoPlatformProvider({
        ...f.options,
        configuration: { ...config, issuer: prefix + "a".repeat(42) },
      }),
    ).not.toThrow();
    expect(() =>
      createCognitoPlatformProvider({
        ...f.options,
        configuration: { ...config, issuer: prefix + "a".repeat(43) },
      }),
    ).toThrow(BrowserSessionError);
  });

  it.each([
    "redirect",
    "oversized header",
    "oversized body",
    "wrong content type",
    "invalid JSON",
    "missing refresh",
    "oversized JWT",
    "bad JWKS",
  ])("fails closed for %s network content", async (mode) => {
    const f = fixture();
    if (mode === "redirect")
      f.changes.tokenNetwork = () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.example.test" },
        });
    if (mode === "oversized header")
      f.changes.tokenNetwork = () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "32769" },
        });
    if (mode === "oversized body")
      f.changes.tokenNetwork = () =>
        new Response(" ".repeat(32769), { headers: { "content-type": "application/json" } });
    if (mode === "wrong content type")
      f.changes.tokenNetwork = () =>
        new Response("{}", { headers: { "content-type": "text/html" } });
    if (mode === "invalid JSON")
      f.changes.tokenNetwork = () =>
        new Response("{", { headers: { "content-type": "application/json" } });
    if (mode === "missing refresh") f.changes.response.refresh_token = undefined;
    if (mode === "oversized JWT") f.changes.response.access_token = "x".repeat(8193);
    if (mode === "bad JWKS") f.changes.jwksNetwork = () => Response.json({ keys: [] });
    await expect(f.create().exchangeCode(request)).rejects.toEqual(
      new BrowserSessionError("BROWSER_SESSION_DENIED"),
    );
    expect(f.resolveVerifiedSubject).not.toHaveBeenCalled();
    expect(f.nextEvidenceReference).not.toHaveBeenCalled();
  });

  it("revokes only the minimal refresh bundle, returns uncertainty on failure, and exposes only a fixed browser logout destination", async () => {
    const f = fixture(),
      provider = f.create(),
      signed = await provider.exchangeCode(request);
    expect(await provider.revokeRefreshTokens(signed.tokenBundle)).toBe("confirmed");
    const revoke = f.calls.find((call) => call.url.endsWith("/oauth2/revoke"));
    expect(Object.fromEntries(new URLSearchParams(String(revoke?.init?.body)))).toEqual({
      token: "synthetic-only-refresh-token",
      token_type_hint: "refresh_token",
    });
    expect(revoke?.init?.redirect).toBe("error");
    f.changes.revokeNetwork = () => {
      throw new Error("SYNTHETIC_NETWORK_FAILURE");
    };
    expect(await provider.revokeRefreshTokens(signed.tokenBundle)).toBe("unknown");
    const count = f.calls.length;
    expect(
      await provider.revokeRefreshTokens(
        JSON.stringify({ ...JSON.parse(signed.tokenBundle), clientId: "other" }),
      ),
    ).toBe("unknown");
    expect(
      await provider.revokeRefreshTokens(
        JSON.stringify({ ...JSON.parse(signed.tokenBundle), id_token: "must-not-keep" }),
      ),
    ).toBe("unknown");
    expect(f.calls).toHaveLength(count);
    expect(provider.createLogoutUrl()).not.toMatch(/token|nonce|secret|subject/u);
  });

  it("bounds a stalled refresh transport even if it ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      provider = f.create();
    f.changes.revokeNetwork = () => new Promise<Response>(() => undefined);
    const pending = provider.revokeRefreshTokens(
      JSON.stringify({
        profile: "CognitoPlatformRefreshV1",
        issuer: config.issuer,
        clientId: config.clientId,
        refreshToken: "synthetic-only-refresh-token",
      }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBe("unknown");
  });
});
