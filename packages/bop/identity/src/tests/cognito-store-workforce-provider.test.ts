import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DescribeUserPoolCommand,
  GetUserPoolMfaConfigCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { createIdentityActor } from "../contracts/identity-actor.js";
import { BrowserSessionError } from "../contracts/browser-session.js";
import {
  createCognitoStoreWorkforceProvider,
  type CognitoStoreWorkforceProviderOptions,
} from "../infrastructure/cognito-store-workforce-provider.js";
import { createCognitoProviderProtocol } from "../infrastructure/cognito-provider-protocol.js";
import {
  cognitoPoolMfaMaximumAgeMs,
  judgeCognitoPoolMfa,
} from "../infrastructure/cognito-pool-mfa-policy.js";
import {
  maskStaffEmail,
  storeStaffActorFromProviderUsername,
  storeStaffInvitationIntentDigest,
  storeStaffProviderUsername,
  storeStaffSubjectHash,
} from "../infrastructure/persistence/store-staff-account-store.js";

// WP-2423 DEC-COGNITO-STORE-STAFF. Local RSA keys, signed JWTs and HTTP responses are synthetic;
// the installed verification libraries run unchanged and no verifier result is mocked. The AWS SDK
// send boundary answers the pool MFA admin calls (GetUserPoolMfaConfig / DescribeUserPool).
const sdk = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-cognito-identity-provider")>();
  return {
    ...actual,
    CognitoIdentityProviderClient: class {
      send = sdk.send;
    },
  };
});
type PoolMode =
  | "on-totp"
  | "optional"
  | "off"
  | "sms"
  | "email"
  | "passwordless"
  | "remembered-devices"
  | "other-pool";
const poolAnswer = (mode: PoolMode) => async (command: unknown) => {
  if (command instanceof GetUserPoolMfaConfigCommand)
    return {
      MfaConfiguration: mode === "optional" ? "OPTIONAL" : mode === "off" ? "OFF" : "ON",
      SoftwareTokenMfaConfiguration: { Enabled: mode !== "off" },
      ...(mode === "sms" ? { SmsMfaConfiguration: { SmsAuthenticationMessage: "{####}" } } : {}),
      ...(mode === "email" ? { EmailMfaConfiguration: { Subject: "Code" } } : {}),
    };
  if (command instanceof DescribeUserPoolCommand)
    return {
      UserPool: {
        Id: mode === "other-pool" ? "ca-central-1_Other" : "ca-central-1_Synthetic",
        MfaConfiguration: mode === "optional" ? "OPTIONAL" : mode === "off" ? "OFF" : "ON",
        Policies: {
          SignInPolicy: {
            AllowedFirstAuthFactors:
              mode === "passwordless" ? ["PASSWORD", "WEB_AUTHN"] : ["PASSWORD"],
          },
        },
        ...(mode === "remembered-devices"
          ? { DeviceConfiguration: { ChallengeRequiredOnNewDevice: true } }
          : {}),
      },
    };
  throw new Error("UNEXPECTED_SDK_COMMAND");
};
beforeEach(() => {
  sdk.send.mockReset();
  sdk.send.mockImplementation(poolAnswer("on-totp"));
});
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
  clientId: "syntheticstoreclient",
  clientSecret: "synthetic-confidential-client-secret",
  managedLoginOrigin: "https://synthetic.auth.ca-central-1.amazoncognito.com",
  redirectUri: "https://store.example.test/merchant/callback",
  logoutReturnUri: "https://store.example.test/app",
};
const stepUpRedirectUri = "https://store.example.test/merchant/identity/step-up/callback";
const actorReference = "01902627-0300-7000-8000-000000000001";
const subject = "11111111-2222-4333-8444-555555555555";
const references = ["01902627-0300-7000-8000-000000000003", "01902627-0300-7000-8000-000000000004"];
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => {
  const body = `${encode({ alg: "RS256", kid: "k", typ: "JWT" })}.${encode(claims)}`;
  return body + "." + sign("RSA-SHA256", Buffer.from(body), key.privateKey).toString("base64url");
};
function fixture(shape: "cognito" | "acr-amr" = "cognito") {
  const second = Math.floor(Date.now() / 1000);
  const changes: {
    id: Record<string, unknown>;
    common: Record<string, unknown>;
    revoke: number;
  } = { id: {}, common: {}, revoke: 0 };
  let offset = 0;
  const calls: string[] = [];
  const http = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === config.issuer + "/.well-known/jwks.json")
      return Response.json({
        keys: [{ ...key.publicKey.export({ format: "jwk" }), kid: "k", use: "sig", alg: "RS256" }],
      });
    if (url === config.managedLoginOrigin + "/oauth2/token") {
      const common = {
        iss: config.issuer,
        sub: subject,
        auth_time: second,
        iat: second,
        exp: second + 3600,
        // Real user-pool tokens carry no acr/amr; the older expected shape has both.
        ...(shape === "acr-amr" ? { acr: "urn:cognito:loa:4", amr: ["pwd", "otp", "mfa"] } : {}),
        ...changes.common,
      };
      return Response.json({
        id_token: jwt({
          ...common,
          token_use: "id",
          aud: config.clientId,
          nonce: "n".repeat(43),
          "cognito:username": storeStaffProviderUsername(actorReference),
          ...changes.id,
        }),
        access_token: jwt({
          ...common,
          token_use: "access",
          client_id: config.clientId,
          scope: "openid",
        }),
        refresh_token: "synthetic-only-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url === config.managedLoginOrigin + "/oauth2/revoke") {
      changes.revoke += 1;
      return new Response(null, { status: 200 });
    }
    throw new Error("UNEXPECTED_TEST_ENDPOINT");
  });
  let n = 0;
  const resolveSubject = vi.fn<CognitoStoreWorkforceProviderOptions["resolveSubject"]>(
    async ({ authenticatedAt }) =>
      createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt,
        recentMfaAt: null,
      }),
  );
  const options: CognitoStoreWorkforceProviderOptions = {
    configuration: { ...config },
    stepUpRedirectUri,
    clock: { now: () => new Date(Date.now() + offset).toISOString() },
    nextReference: () => references[n++ % references.length] as string,
    resolveSubject,
    http,
  };
  return {
    options,
    changes,
    calls,
    resolveSubject,
    second,
    move(ms: number) {
      offset = ms;
    },
    create: () => createCognitoStoreWorkforceProvider(options),
  };
}
const authorize = (redirectUri: string) => ({
  issuer: config.issuer,
  clientId: config.clientId,
  redirectUri,
  state: "s".repeat(43),
  nonce: "n".repeat(43),
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256" as const,
});
const exchange = (
  redirectUri: string,
  authorizationStartedAt = new Date(Date.now() - 60_000).toISOString(),
) => ({
  issuer: config.issuer,
  clientId: config.clientId,
  redirectUri,
  code: "synthetic-code",
  nonce: "n".repeat(43),
  codeVerifier: "v".repeat(43),
  authorizationStartedAt,
});

describe("Cognito Store staff provider", () => {
  it("signs staff in with the managed login, prompt=login and the authenticator every time", async () => {
    const f = fixture();
    const url = new URL(await f.create().createAuthorizationUrl(authorize(config.redirectUri)));
    expect(url.origin + url.pathname).toBe(config.managedLoginOrigin + "/oauth2/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("max_age")).toBe("0");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
  it("resolves the verified subject and signed username and keeps only the refresh token", async () => {
    const f = fixture();
    const result = await f.create().exchangeCode(exchange(config.redirectUri));
    const authenticatedAt = new Date(f.second * 1000).toISOString();
    expect(f.resolveSubject).toHaveBeenCalledExactlyOnceWith({
      issuer: config.issuer,
      clientId: config.clientId,
      subject,
      username: "bop_" + actorReference,
      authenticatedAt,
      observedAt: expect.any(String),
    });
    expect(result.actor.actorReference).toBe(actorReference);
    expect(result.actor.authenticatedAt).toBe(authenticatedAt);
    expect(result.tokenBundle).not.toMatch(/id_token|access_token|email|clientSecret/u);
    expect(await f.create().revokeOrLogout(result.tokenBundle)).toBe("confirmed");
  });
  it("refuses tokens without a signed username, or a resolver naming another sign-in time", async () => {
    const f = fixture();
    f.changes.id["cognito:username"] = undefined;
    await expect(f.create().exchangeCode(exchange(config.redirectUri))).rejects.toBeInstanceOf(
      BrowserSessionError,
    );
    const g = fixture();
    g.resolveSubject.mockImplementation(async () =>
      createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: "2026-01-01T00:00:00.000Z",
        recentMfaAt: null,
      }),
    );
    await expect(g.create().exchangeCode(exchange(config.redirectUri))).rejects.toBeInstanceOf(
      BrowserSessionError,
    );
  });
  it("re-authenticates on its own callback, returns the fresh sign-in and revokes its token", async () => {
    const f = fixture();
    const provider = f.create();
    const url = new URL(await provider.stepUp.createAuthorizationUrl(authorize(stepUpRedirectUri)));
    expect(url.searchParams.get("redirect_uri")).toBe(stepUpRedirectUri);
    expect(url.searchParams.get("prompt")).toBe("login");
    const verified = await provider.stepUp.verify(exchange(stepUpRedirectUri));
    expect(verified).toMatchObject({ subject, username: "bop_" + actorReference });
    expect(f.changes.revoke).toBe(1);
    expect(f.resolveSubject).not.toHaveBeenCalled();
    // The sign-in callback never answers a step-up request and the other way round.
    await expect(provider.stepUp.verify(exchange(config.redirectUri))).rejects.toBeInstanceOf(
      BrowserSessionError,
    );
  });
  it("accepts only the Store callbacks for the Store profile", () => {
    for (const redirectUri of [
      "https://store.example.test/merchant/organization/brands/callback",
      "https://store.example.test/merchant/other",
    ])
      expect(() =>
        createCognitoProviderProtocol({
          configuration: { ...config, redirectUri },
          clock: { now: () => new Date().toISOString() },
          accountKind: "Workforce",
          profile: "StoreOperations",
        }),
      ).toThrow(BrowserSessionError);
    expect(() =>
      createCognitoProviderProtocol({
        configuration: { ...config },
        clock: { now: () => new Date().toISOString() },
        accountKind: "Platform",
        profile: "StoreOperations",
      }),
    ).toThrow(BrowserSessionError);
    expect(() =>
      createCognitoStoreWorkforceProvider({
        ...fixture().options,
        stepUpRedirectUri: "https://elsewhere.example.test/merchant/identity/step-up/callback",
      }),
    ).toThrow(BrowserSessionError);
  });
});

describe("WP-2423 Cognito Store staff with real Cognito token claims", () => {
  const unavailable = expect.objectContaining({ code: "BROWSER_SESSION_UNAVAILABLE" });
  it.each(["cognito", "acr-amr"] as const)(
    "signs in and steps up with %s tokens once the pool requires the authenticator app",
    async (shape) => {
      const f = fixture(shape);
      const provider = f.create();
      await provider.createAuthorizationUrl(authorize(config.redirectUri));
      const result = await provider.exchangeCode(exchange(config.redirectUri));
      expect(result.actor.actorReference).toBe(actorReference);
      const verified = await provider.stepUp.verify(exchange(stepUpRedirectUri));
      expect(verified.subject).toBe(subject);
      // One pool check (two admin reads) serves every sign-in for five minutes.
      expect(sdk.send).toHaveBeenCalledTimes(2);
      expect(provider.pool.status()).toMatchObject({ state: "Verified", reason: null });
    },
  );
  it.each([
    ["optional", "MfaNotRequired"],
    ["off", "MfaNotRequired"],
    ["sms", "TextMessageMfaEnabled"],
    ["email", "EmailMfaEnabled"],
    ["passwordless", "PasswordlessSignInAllowed"],
    ["remembered-devices", "RememberedDevicesSkipMfa"],
    ["other-pool", "Unavailable"],
  ] as const)(
    "refuses sign-in and step-up when the pool is %s, recording nothing",
    async (mode, reason) => {
      sdk.send.mockImplementation(poolAnswer(mode));
      const f = fixture();
      const provider = f.create();
      await expect(provider.createAuthorizationUrl(authorize(config.redirectUri))).rejects.toEqual(
        unavailable,
      );
      await expect(
        provider.stepUp.createAuthorizationUrl(authorize(stepUpRedirectUri)),
      ).rejects.toEqual(unavailable);
      await expect(provider.exchangeCode(exchange(config.redirectUri))).rejects.toBeInstanceOf(
        BrowserSessionError,
      );
      await expect(provider.stepUp.verify(exchange(stepUpRedirectUri))).rejects.toBeInstanceOf(
        BrowserSessionError,
      );
      expect(f.calls.filter((url) => url.endsWith("/oauth2/token"))).toEqual([]);
      expect(f.resolveSubject).not.toHaveBeenCalled();
      expect(provider.pool.status()).toMatchObject({ reason });
    },
  );
  it("fails closed when the pool check errors or does not answer, and checks again when stale", async () => {
    sdk.send.mockRejectedValue(new Error("SYNTHETIC_ACCESS_DENIED"));
    const f = fixture();
    const provider = f.create();
    await expect(provider.createAuthorizationUrl(authorize(config.redirectUri))).rejects.toEqual(
      unavailable,
    );
    expect(provider.pool.status()).toMatchObject({ state: "Unknown", reason: "Unavailable" });
    sdk.send.mockReset();
    sdk.send.mockImplementation(() => new Promise(() => undefined));
    await expect(provider.createAuthorizationUrl(authorize(config.redirectUri))).rejects.toEqual(
      unavailable,
    );
    // Back to required MFA: verified, reused, then checked again after five minutes.
    sdk.send.mockReset();
    sdk.send.mockImplementation(poolAnswer("on-totp"));
    await provider.createAuthorizationUrl(authorize(config.redirectUri));
    await provider.createAuthorizationUrl(authorize(config.redirectUri));
    expect(sdk.send).toHaveBeenCalledTimes(2);
    f.move(cognitoPoolMfaMaximumAgeMs);
    sdk.send.mockImplementation(poolAnswer("optional"));
    await expect(provider.createAuthorizationUrl(authorize(config.redirectUri))).rejects.toEqual(
      unavailable,
    );
    expect(sdk.send).toHaveBeenCalledTimes(4);
  }, 15_000);
  it("still enforces acr and amr when a token carries them", async () => {
    for (const common of [
      { acr: "urn:cognito:loa:1" },
      { amr: ["pwd"] },
      { amr: ["pwd", "sms"] },
      { amr: ["otp", "mfa"] },
      { amr: "pwd otp" },
    ]) {
      const f = fixture();
      f.changes.common = common;
      await expect(f.create().exchangeCode(exchange(config.redirectUri))).rejects.toBeInstanceOf(
        BrowserSessionError,
      );
      expect(f.resolveSubject).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.changes.common = { amr: ["pwd", "otp"] };
    await expect(f.create().exchangeCode(exchange(config.redirectUri))).resolves.toBeDefined();
  });
  it("needs a fresh sign-in after the authorization began (prompt=login), within five minutes", async () => {
    const f = fixture();
    const provider = f.create();
    // Signed before this sign-in was started (an earlier Cognito session reused).
    await expect(
      provider.exchangeCode(
        exchange(config.redirectUri, new Date(f.second * 1000 + 30_000).toISOString()),
      ),
    ).rejects.toBeInstanceOf(BrowserSessionError);
    await expect(
      provider.stepUp.verify(
        exchange(stepUpRedirectUri, new Date(f.second * 1000 + 30_000).toISOString()),
      ),
    ).rejects.toBeInstanceOf(BrowserSessionError);
    // Within the clock allowance it is accepted.
    await expect(
      provider.exchangeCode(
        exchange(config.redirectUri, new Date(f.second * 1000 + 5_000).toISOString()),
      ),
    ).resolves.toBeDefined();
    // No start time: refused.
    const withoutStart: Partial<ReturnType<typeof exchange>> = exchange(config.redirectUri);
    delete withoutStart.authorizationStartedAt;
    await expect(provider.exchangeCode(withoutStart as never)).rejects.toBeInstanceOf(
      BrowserSessionError,
    );
    // An authentication older than five minutes at the callback.
    const old = fixture();
    old.changes.common = { auth_time: old.second - 301, iat: old.second - 301 };
    await expect(
      old
        .create()
        .exchangeCode(
          exchange(config.redirectUri, new Date((old.second - 400) * 1000).toISOString()),
        ),
    ).rejects.toBeInstanceOf(BrowserSessionError);
  });
  it("judges the pool settings exactly", () => {
    const mfa = { MfaConfiguration: "ON", SoftwareTokenMfaConfiguration: { Enabled: true } };
    const pool = (extra: Record<string, unknown> = {}) => ({
      UserPool: { Id: "ca-central-1_P", MfaConfiguration: "ON", ...extra },
    });
    expect(judgeCognitoPoolMfa("ca-central-1_P", mfa, pool())).toBeNull();
    expect(
      judgeCognitoPoolMfa(
        "ca-central-1_P",
        mfa,
        pool({ DeviceConfiguration: { ChallengeRequiredOnNewDevice: false } }),
      ),
    ).toBeNull();
    expect(
      judgeCognitoPoolMfa(
        "ca-central-1_P",
        mfa,
        pool({ Policies: { SignInPolicy: { AllowedFirstAuthFactors: [] } } }),
      ),
    ).toBe("PasswordlessSignInAllowed");
    expect(
      judgeCognitoPoolMfa("ca-central-1_P", { ...mfa, SoftwareTokenMfaConfiguration: {} }, pool()),
    ).toBe("AuthenticatorAppNotEnabled");
    expect(judgeCognitoPoolMfa("ca-central-1_P", mfa, pool({ MfaConfiguration: "OPTIONAL" }))).toBe(
      "MfaNotRequired",
    );
    expect(judgeCognitoPoolMfa("ca-central-1_P", mfa, {})).toBe("Unavailable");
    expect(judgeCognitoPoolMfa("ca-central-1_P", null, null)).toBe("Unavailable");
  });
});

describe("Store staff account helpers", () => {
  it("names invited people by username and keeps subjects and emails out of storage", () => {
    expect(storeStaffActorFromProviderUsername("bop_" + actorReference)).toBe(actorReference);
    for (const value of ["bop_x", actorReference, "admin", null, "bop_" + actorReference + "x"])
      expect(storeStaffActorFromProviderUsername(value)).toBeNull();
    const hasher = {
      hash: (value: string) => Buffer.from(value).toString("hex").slice(0, 64).padEnd(64, "0"),
      equals: (a: string, b: string) => a === b,
    };
    const hash = storeStaffSubjectHash(hasher as never, {
      environment: "synthetic",
      issuer: config.issuer,
      subject,
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(hash).not.toContain(Buffer.from(subject).toString("hex"));
    expect(maskStaffEmail("mia.chen@example.test")).toBe("m•••@example.test");
    expect(() => maskStaffEmail("not an email")).toThrow();
    const digest = (invitationReference: string) =>
      storeStaffInvitationIntentDigest({
        invitationReference,
        actorReference,
        brandReference: references[0] as string,
        storeReference: references[1] as string,
        pool: { environment: "synthetic", issuer: config.issuer, clientId: config.clientId },
      });
    expect(digest(references[0] as string)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(digest(references[0] as string)).not.toBe(digest(references[1] as string));
  });
});
