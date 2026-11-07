import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import console from "node:console";
import process from "node:process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cognitoPostLoginPaths,
  createInternalMerchantCognitoSession,
} from "./pilot-merchant-cognito-session.mjs";
import { startCognitoTestProvider } from "./cognito-test-provider.mjs";

// WP-2423 DEC-COGNITO-STORE-STAFF: the pilot composition's Cognito staff sessions.
const ref = (n) => "0190d000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const previous = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = "development";
});
afterEach(() => {
  process.env.NODE_ENV = previous;
});
const signIn = (overrides = {}) => ({
  mode: "cognito",
  environment: "InternalTest",
  exactOrigin: "https://127.0.0.1:4443",
  acceptedHost: "127.0.0.1:4443",
  cognito: {
    environment: "bop-pilot",
    issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
    clientId: "syntheticclient",
    clientSecret: "synthetic-secret",
    managedLoginOrigin: "https://synthetic.auth.ca-central-1.amazoncognito.com",
  },
  staffPinKeys: {
    pepper: Buffer.alloc(32, 1),
    device: Buffer.alloc(32, 2),
    choice: Buffer.alloc(32, 3),
  },
  testProvider: null,
  ...overrides,
});
const started = [];
afterEach(async () => {
  for (const session of started.splice(0)) session.poolCheck.stop();
});
/** TEST-ONLY: the loopback Cognito stand-in answering the pool MFA check. */
async function withProvider(poolMfa = "on-totp") {
  const fake = await startCognitoTestProvider({ pool: "ca-central-1_Synthetic", poolMfa });
  return {
    fake,
    config: signIn({
      cognito: {
        ...signIn().cognito,
        issuer: fake.issuer,
        clientId: fake.clientId,
        clientSecret: fake.clientSecret,
        managedLoginOrigin: fake.managedLoginOrigin,
      },
      testProvider: { origin: fake.origin, browserOrigin: null },
    }),
  };
}
let n = 10;
const resources = {
  now: () => new Date().toISOString(),
  transactions: { run: async () => undefined },
  credentials: { reference: () => ref(n++) },
  publicProfile: { binding: { tenantReference: ref(1) } },
  scope: { brandReference: ref(2), storeReference: ref(3) },
};
const crypto = async () => ({
  hasher: {
    hash: (value) => createHash("sha256").update(value).digest("hex"),
    equals: (a, b) => a === b,
  },
  envelopes: { encrypt: async () => ({}), decrypt: async () => "" },
});

it("composes the Cognito sign-in with its own sign-in page, invitations, step-up and PIN keys", async () => {
  const { fake, config } = await withProvider();
  const session = await createInternalMerchantCognitoSession(resources, {
    signIn: config,
    createInternalMerchantCredentials: crypto,
  });
  started.push(session);
  expect(session.mode).toBe("cognito");
  expect(session.signInEntry).toEqual({ path: "/operations/sign-in", testOnly: false });
  expect(session.identity.configuration).toMatchObject({
    redirectUri: "https://127.0.0.1:4443/merchant/callback",
    environment: "bop-pilot",
    allowedPostLoginPaths: cognitoPostLoginPaths,
  });
  expect(session.identity.postLoginPolicies).toEqual({
    "/operations/kitchen/start": "NamedKdsOperator",
  });
  expect(session.invitations.pool.clientId).toBe(fake.clientId);
  expect(typeof session.createProviderStepUp).toBe("function");
  expect(typeof session.onFullSignIn).toBe("function");
  expect(session.issue).toBeUndefined();
  expect(session.staffChoices).toBeUndefined();
  const pin = await session.staffPinCredentials();
  expect(Object.keys(pin).sort()).toEqual(["choiceTokens", "deviceHasher", "kdf"]);
  const url = new globalThis.URL(
    await session.identity.provider.createAuthorizationUrl({
      issuer: fake.issuer,
      clientId: fake.clientId,
      redirectUri: "https://127.0.0.1:4443/merchant/callback",
      state: "s".repeat(43),
      nonce: "n".repeat(43),
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
    }),
  );
  expect(url.origin).toBe(fake.managedLoginOrigin);
  expect(JSON.stringify(session.identity.configuration)).not.toContain(fake.clientSecret);
  // The pool MFA check ran at startup against the stand-in and passed.
  await vi.waitFor(() => expect(session.poolCheck.status().state).toBe("Verified"));
  expect(fake.calls.map((call) => call.target).filter(Boolean)).toEqual(
    expect.arrayContaining([
      "AWSCognitoIdentityProviderService.GetUserPoolMfaConfig",
      "AWSCognitoIdentityProviderService.DescribeUserPool",
    ]),
  );
  await fake.close();
});

it("refuses to start a sign-in and logs only the setting name when the pool does not require the authenticator app", async () => {
  const { fake, config } = await withProvider("optional");
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const session = await createInternalMerchantCognitoSession(resources, {
      signIn: config,
      createInternalMerchantCredentials: crypto,
    });
    started.push(session);
    await expect(
      session.identity.provider.createAuthorizationUrl({
        issuer: fake.issuer,
        clientId: fake.clientId,
        redirectUri: "https://127.0.0.1:4443/merchant/callback",
        state: "s".repeat(43),
        nonce: "n".repeat(43),
        codeChallenge: "c".repeat(43),
        codeChallengeMethod: "S256",
      }),
    ).rejects.toMatchObject({ code: "BROWSER_SESSION_UNAVAILABLE" });
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    const logged = errors.mock.calls.map((call) => String(call[0])).join("\n");
    expect(JSON.parse(logged.split("\n")[0])).toEqual({
      event: "STAFF_SIGN_IN_POOL_CHECK_REFUSED",
      state: "Refused",
      reason: "MfaNotRequired",
    });
    expect(logged).not.toContain(fake.clientSecret);
  } finally {
    errors.mockRestore();
    await fake.close();
  }
});

it("refuses another origin and a TEST-ONLY stand-in outside development", async () => {
  await expect(
    createInternalMerchantCognitoSession(resources, {
      signIn: signIn({ exactOrigin: "https://staff.example.test" }),
      createInternalMerchantCredentials: crypto,
    }),
  ).rejects.toThrow();
  process.env.NODE_ENV = "production";
  await expect(
    createInternalMerchantCognitoSession(resources, {
      signIn: signIn({ testProvider: { origin: "http://127.0.0.1:4599", browserOrigin: null } }),
      createInternalMerchantCredentials: crypto,
    }),
  ).rejects.toThrow();
  await expect(
    createInternalMerchantCognitoSession(resources, {
      signIn: { mode: "internal-test" },
      createInternalMerchantCredentials: crypto,
    }),
  ).rejects.toThrow();
});
