import { Buffer } from "node:buffer";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentityActor } from "../contracts/identity-actor.js";
import {
  BrowserSessionError,
  parseAuthorizationTransactionReference,
} from "../contracts/browser-session.js";
import {
  createCognitoWorkforceProvider,
  type CognitoWorkforceProviderOptions,
} from "../infrastructure/cognito-workforce-provider.js";
import { createCognitoProviderProtocol } from "../infrastructure/cognito-provider-protocol.js";

// Local RSA keys, signed JWTs and HTTP responses are synthetic. Both installed
// verification libraries run unchanged; no verifier or signature result is mocked.
const idKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const accessKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
  clientId: "syntheticworkforceclient",
  clientSecret: "synthetic-confidential-client-secret",
  managedLoginOrigin: "https://synthetic.auth.ca-central-1.amazoncognito.com",
  redirectUri: "https://app.example.test/merchant/organization/brands/callback",
  logoutReturnUri: "https://app.example.test/app/organization/brands",
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

  const resolveVerifiedSubject = vi.fn<CognitoWorkforceProviderOptions["resolveVerifiedSubject"]>(
    async ({ authenticatedAt }) =>
      createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        recentMfaAt: null,
        authenticatedAt,
      }),
  );
  const nextEvidenceReference = vi.fn(() => evidenceReference);
  const options: CognitoWorkforceProviderOptions = {
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
    create: () => createCognitoWorkforceProvider(options),
    protocol: () =>
      createCognitoProviderProtocol({
        configuration: options.configuration,
        clock: options.clock,
        accountKind: "Workforce",
        http,
      }),
  };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("Cognito Workforce Provider", () => {
  const emailDigest = (email: unknown) => {
    if (typeof email !== "string" || !/^[A-Za-z0-9._+-]+@example\.test$/u.test(email))
      throw new Error("CONTROLLED_EMAIL_INVALID");
    return createHmac("sha256", "synthetic-email-test-key")
      .update(email.toLowerCase())
      .digest("hex");
  };
  it("checks intended email only from a verified signed ID token without returning the email", async () => {
    const f = fixture();
    f.changes.id.email_verified = true;
    const verified = await f.protocol().exchangeVerifiedCode(request);
    expect(() =>
      verified.assertIntendedEmail(emailDigest("synthetic-unused@example.test"), emailDigest),
    ).not.toThrow();
    expect(JSON.stringify(verified)).not.toMatch(/email|synthetic-unused@example\.test/u);
    expect(() =>
      verified.assertIntendedEmail(emailDigest("different@example.test"), emailDigest),
    ).toThrow(BrowserSessionError);
  });
  it.each([undefined, false, "true", 1, null])(
    "rejects non-boolean verified email evidence %s before passing email to a digest producer",
    async (emailVerified) => {
      const f = fixture();
      f.changes.id.email_verified = emailVerified;
      const verified = await f.protocol().exchangeVerifiedCode(request),
        digest = vi.fn(emailDigest);
      expect(() =>
        verified.assertIntendedEmail(emailDigest("synthetic-unused@example.test"), digest),
      ).toThrow(BrowserSessionError);
      expect(digest).not.toHaveBeenCalled();
    },
  );
  it("refuses malformed digest results and never renews the original verified-token lease", async () => {
    const f = fixture();
    f.changes.id.email_verified = true;
    const verified = await f.protocol().exchangeVerifiedCode(request),
      expected = emailDigest("synthetic-unused@example.test");
    expect(() => verified.assertIntendedEmail(expected, () => Promise.resolve(expected))).toThrow(
      BrowserSessionError,
    );
    expect(() =>
      verified.assertIntendedEmail(expected, (email) => {
        f.setClock(new Date(Date.parse(verified.observedAt) + 5000).toISOString());
        return emailDigest(email);
      }),
    ).toThrow(BrowserSessionError);
    expect(() => verified.assertIntendedEmail(expected, emailDigest)).toThrow(BrowserSessionError);
  });
  it("uses actual dual signatures and exact Workforce subject binding for a same-transaction TOTP proof", async () => {
    const f = fixture(),
      p = f.create(),
      url = new URL(await p.createAuthorizationUrl(authorizeRequest()));
    expect(url.origin + url.pathname).toBe(config.managedLoginOrigin + "/oauth2/authorize");
    expect(url.searchParams.get("identity_provider")).toBe("COGNITO");
    expect(url.searchParams.get("acr_values")).toBe("urn:cognito:loa:4");
    expect(url.searchParams.get("max_age")).toBe("0");
    const result = await p.exchangeCode(request),
      authenticatedAt = new Date(f.second * 1000).toISOString();
    expect(f.resolveVerifiedSubject).toHaveBeenCalledExactlyOnceWith({
      issuer: config.issuer,
      clientId: config.clientId,
      subject,
      authenticatedAt,
      observedAt: f.options.clock.now(),
    });
    expect(result.actor).toEqual(
      createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Workforce",
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
      evidenceReference,
      actorReference,
      issuer: config.issuer,
      clientId: config.clientId,
      authorizationTransactionReference: transactionReference,
      nonce: request.nonce,
      authenticatedAt,
      verifiedAt: authenticatedAt,
    });
    expect(JSON.parse(result.tokenBundle)).toEqual({
      profile: "CognitoWorkforceRefreshV1",
      issuer: config.issuer,
      clientId: config.clientId,
      refreshToken: "synthetic-only-refresh-token",
    });
    expect(result.tokenBundle).not.toMatch(
      /email|groups|id_token|access_token|nonce|clientSecret/u,
    );
    expect(f.nextEvidenceReference).toHaveBeenCalledOnce();
  });
  it("never uses a verified opaque subject, email or groups as Actor/permission identity", async () => {
    const f = fixture();
    f.changes.id.sub = "opaque-subject";
    f.changes.access.sub = "opaque-subject";
    const result = await f.create().exchangeCode(request);
    expect(f.resolveVerifiedSubject).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "opaque-subject" }),
    );
    expect(result.actor.actorReference).toBe(actorReference);
    expect(result.actor).not.toHaveProperty("roles");
    expect(result.tokenBundle).not.toContain("opaque-subject");
  });
  it.each(["Platform", "Customer"] as const)(
    "rejects a real %s actor returned by the resolver",
    async (accountKind) => {
      const f = fixture();
      f.resolveVerifiedSubject.mockImplementation(async ({ authenticatedAt }) =>
        createIdentityActor({
          actorType: "User",
          actorReference,
          accountKind,
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt,
          recentMfaAt: null,
        }),
      );
      await expect(f.create().exchangeCode(request)).rejects.toBeInstanceOf(BrowserSessionError);
      expect(f.nextEvidenceReference).not.toHaveBeenCalled();
    },
  );
  it.each(["RecentMfa", "wrong auth", "unavailable"] as const)(
    "requires original SingleFactor Workforce binding: %s",
    async (mode) => {
      const f = fixture();
      f.resolveVerifiedSubject.mockImplementation(async ({ authenticatedAt }) => {
        if (mode === "unavailable") throw Error("controlled reader unavailable");
        return createIdentityActor({
          actorType: "User",
          actorReference,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: mode === "RecentMfa" ? "RecentMfa" : "SingleFactor",
          authenticatedAt:
            mode === "wrong auth" ? new Date((f.second - 1) * 1000).toISOString() : authenticatedAt,
          recentMfaAt: mode === "RecentMfa" ? authenticatedAt : null,
        });
      });
      await expect(f.create().exchangeCode(request)).rejects.toBeInstanceOf(BrowserSessionError);
      expect(f.nextEvidenceReference).not.toHaveBeenCalled();
    },
  );
  it.each(["id", "access"] as const)(
    "refuses forged %s signature before invoking the owner",
    async (use) => {
      const f = fixture();
      f.changes.badSignature = use;
      await expect(f.create().exchangeCode(request)).rejects.toBeInstanceOf(BrowserSessionError);
      expect(f.resolveVerifiedSubject).not.toHaveBeenCalled();
      expect(f.nextEvidenceReference).not.toHaveBeenCalled();
    },
  );
  it.each([
    "lower assurance",
    "SMS",
    "missing nonce",
    "different subject",
    "different auth",
  ] as const)("refuses invalid signed claims: %s", async (mode) => {
    const f = fixture();
    if (mode === "lower assurance") f.changes.id.acr = "urn:cognito:loa:3";
    if (mode === "SMS") f.changes.access.amr = ["pwd", "sms", "mfa"];
    if (mode === "missing nonce") f.changes.id.nonce = "different";
    if (mode === "different subject") f.changes.access.sub = "other";
    if (mode === "different auth") f.changes.access.auth_time = f.second - 1;
    await expect(f.create().exchangeCode(request)).rejects.toBeInstanceOf(BrowserSessionError);
    expect(f.resolveVerifiedSubject).not.toHaveBeenCalled();
  });
  it.each(["expiry", "rollback"] as const)(
    "preserves the original exchange lease after real binding: %s",
    async (mode) => {
      const f = fixture();
      f.resolveVerifiedSubject.mockImplementation(async ({ authenticatedAt, observedAt }) => {
        f.setClock(
          new Date(Date.parse(observedAt) + (mode === "expiry" ? 5000 : -1)).toISOString(),
        );
        return createIdentityActor({
          actorType: "User",
          actorReference,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt,
          recentMfaAt: null,
        });
      });
      await expect(f.create().exchangeCode(request)).rejects.toBeInstanceOf(BrowserSessionError);
      expect(f.nextEvidenceReference).not.toHaveBeenCalled();
    },
  );
  it("rechecks the original lease after evidence allocation", async () => {
    const f = fixture();
    f.nextEvidenceReference.mockImplementation(() => {
      f.setClock(new Date(Date.parse(f.options.clock.now()) + 5000).toISOString());
      return evidenceReference;
    });
    await expect(f.create().exchangeCode(request)).rejects.toBeInstanceOf(BrowserSessionError);
  });
  it.each([
    { redirectUri: "https://app.example.test/platform/auth/callback" },
    { logoutReturnUri: "https://app.example.test/platform/tenants" },
    { logoutReturnUri: "https://other.example.test/app/organization/brands" },
    { issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other" },
  ])("refuses foreign fixed configuration %j", async (change) => {
    const f = fixture();
    expect(() =>
      createCognitoWorkforceProvider({ ...f.options, configuration: { ...config, ...change } }),
    ).toThrow(BrowserSessionError);
    expect(f.http).not.toHaveBeenCalled();
  });
  it("keeps Workforce refresh revocation distinct and uses a fixed browser logout destination", async () => {
    const f = fixture(),
      p = f.create(),
      result = await p.exchangeCode(request);
    expect(await p.revokeRefreshTokens(result.tokenBundle)).toBe("confirmed");
    expect(
      await p.revokeRefreshTokens(
        JSON.stringify({ ...JSON.parse(result.tokenBundle), profile: "CognitoPlatformRefreshV1" }),
      ),
    ).toBe("unknown");
    const logout = new URL(p.createLogoutUrl());
    expect(logout.origin + logout.pathname).toBe(config.managedLoginOrigin + "/logout");
    expect(logout.searchParams.get("logout_uri")).toBe(config.logoutReturnUri);
    f.changes.revokeNetwork = () => new Response(null, { status: 500 });
    expect(await p.revokeRefreshTokens(result.tokenBundle)).toBe("unknown");
  });
  it("refuses request-controlled extra URLs, state and weakened TOTP policy", async () => {
    const f = fixture(),
      p = f.create();
    await expect(
      Reflect.apply(p.exchangeCode, undefined, [{ ...request, state: "unconsumed" }]),
    ).rejects.toThrow(BrowserSessionError);
    await expect(
      Reflect.apply(p.exchangeCode, undefined, [{ ...request, requireTotp: false }]),
    ).rejects.toThrow(BrowserSessionError);
    expect(f.http).not.toHaveBeenCalled();
  });
});
