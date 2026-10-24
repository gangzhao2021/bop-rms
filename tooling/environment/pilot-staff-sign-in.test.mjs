import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createTestProviderFetch,
  loadPilotStaffSignIn,
  readPilotStaffSignInReadiness,
  testProviderAuthorizationUrl,
} from "./pilot-staff-sign-in.mjs";

// WP-2423 DEC-COGNITO-STORE-STAFF: how a pilot installation's staff sign in.
let directory;
const env = { NODE_ENV: "development" };
const pilot = { NODE_ENV: "production", BOP_PILOT_ENVIRONMENT: "Pilot" };
const key = (n) => n.toString(16).repeat(64).slice(0, 64);
const cognito = {
  bindingEnvironment: "bop-pilot",
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
  clientId: "syntheticclient",
  managedLoginOrigin: "https://synthetic.auth.ca-central-1.amazoncognito.com",
  clientSecretFile: "cognito-client-secret",
};
const staffPin = {
  pepperFile: "staff-pin-pepper",
  deviceKeyFile: "store-device-key",
  choiceKeyFile: "staff-pin-choice-key",
};
const config = (overrides = {}) => ({
  schemaVersion: 1,
  environment: "InternalTest",
  mode: "cognito",
  exactOrigin: "https://127.0.0.1:4443",
  cognito,
  staffPin,
  ...overrides,
});
async function file(name, text) {
  await writeFile(join(directory, name), text, { mode: 0o600 });
  await chmod(join(directory, name), 0o600);
}
async function secrets() {
  await file("cognito-client-secret", "synthetic-secret-value\n");
  await file("staff-pin-pepper", key(1));
  await file("store-device-key", key(2));
  await file("staff-pin-choice-key", key(3));
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "bop-staff-sign-in-")));
  await chmod(directory, 0o700);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("keeps the TEST-ONLY sign-in when no staff sign-in file exists", async () => {
  expect(await loadPilotStaffSignIn(directory, { env })).toEqual({ mode: "internal-test" });
  expect(await readPilotStaffSignInReadiness(directory, { env })).toBe("NotConfigured");
  await file(
    "staff-sign-in.json",
    JSON.stringify({ schemaVersion: 1, environment: "InternalTest", mode: "internal-test" }),
  );
  expect(await loadPilotStaffSignIn(directory, { env })).toEqual({ mode: "internal-test" });
});

it("reads the Cognito configuration and every secret file, and never returns them as text", async () => {
  await secrets();
  await file("staff-sign-in.json", JSON.stringify(config()));
  const signIn = await loadPilotStaffSignIn(directory, { env });
  expect(signIn).toMatchObject({
    mode: "cognito",
    exactOrigin: "https://127.0.0.1:4443",
    acceptedHost: "127.0.0.1:4443",
    cognito: {
      environment: "bop-pilot",
      clientId: "syntheticclient",
      clientSecret: "synthetic-secret-value",
    },
    testProvider: null,
  });
  expect(signIn.staffPinKeys.pepper.toString("hex")).toBe(key(1));
  expect(await readPilotStaffSignInReadiness(directory, { env })).toBe("CognitoConfigured");
});

it.each([
  ["a missing secret", async () => file("staff-sign-in.json", JSON.stringify(config()))],
  [
    "a secret readable by others",
    async () => {
      await secrets();
      await chmod(join(directory, "staff-pin-pepper"), 0o644);
      await file("staff-sign-in.json", JSON.stringify(config()));
    },
  ],
  [
    "the same key twice",
    async () => {
      await secrets();
      await file("store-device-key", key(1));
      await file("staff-sign-in.json", JSON.stringify(config()));
    },
  ],
  [
    "another environment",
    async () => {
      await secrets();
      await file("staff-sign-in.json", JSON.stringify(config({ environment: "Pilot" })));
    },
  ],
  [
    "a non-Canadian pool",
    async () => {
      await secrets();
      await file(
        "staff-sign-in.json",
        JSON.stringify(
          config({
            cognito: {
              ...cognito,
              issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_X",
            },
          }),
        ),
      );
    },
  ],
  [
    "an unknown field",
    async () => {
      await secrets();
      await file("staff-sign-in.json", JSON.stringify({ ...config(), extra: true }));
    },
  ],
])("refuses %s and keeps StaffLogin open", async (_label, arrange) => {
  await arrange();
  await expect(loadPilotStaffSignIn(directory, { env })).rejects.toThrow(
    "PILOT_STAFF_SIGN_IN_UNAVAILABLE",
  );
  expect(await readPilotStaffSignInReadiness(directory, { env })).toBe("NotConfigured");
});

it("admits the TEST-ONLY loopback stand-in only in InternalTest, and it never closes the gap", async () => {
  await secrets();
  const testProvider = { origin: "http://127.0.0.1:4599", browserOrigin: "https://127.0.0.1:4600" };
  await file("staff-sign-in.json", JSON.stringify(config({ testProvider })));
  const signIn = await loadPilotStaffSignIn(directory, { env });
  expect(signIn.testProvider).toEqual(testProvider);
  expect(await readPilotStaffSignInReadiness(directory, { env })).toBe("NotConfigured");
  expect(
    testProviderAuthorizationUrl(signIn, cognito.managedLoginOrigin + "/oauth2/authorize?x=1"),
  ).toBe("https://127.0.0.1:4600/oauth2/authorize?x=1");
  const seen = [];
  const fetch = createTestProviderFetch(signIn, async (url) => {
    seen.push(url);
    return new globalThis.Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const response = await fetch(cognito.managedLoginOrigin + "/oauth2/token", { method: "POST" });
  expect(response.url).toBe("");
  await fetch(cognito.issuer + "/.well-known/jwks.json");
  expect(seen).toEqual([
    "http://127.0.0.1:4599/oauth2/token",
    "http://127.0.0.1:4599/ca-central-1_Synthetic/.well-known/jwks.json",
  ]);
  await expect(fetch("https://elsewhere.example.test/")).rejects.toThrow();
  await file(
    "staff-sign-in.json",
    JSON.stringify(config({ environment: "Pilot", testProvider: { origin: testProvider.origin } })),
  );
  await expect(loadPilotStaffSignIn(directory, { env: pilot })).rejects.toThrow(
    "PILOT_STAFF_SIGN_IN_UNAVAILABLE",
  );
});

it("in a Pilot store reads the client secret from the managed secrets and leaves PIN keys to them", async () => {
  const pilotCognito = { ...cognito };
  delete pilotCognito.clientSecretFile;
  const pilotConfig = { ...config({ environment: "Pilot", cognito: pilotCognito }) };
  delete pilotConfig.staffPin;
  await file("staff-sign-in.json", JSON.stringify(pilotConfig));
  const asked = [];
  const readManaged = async (name) => {
    asked.push(name);
    return "managed-client-secret\n";
  };
  const signIn = await loadPilotStaffSignIn(directory, { env: pilot, readManaged });
  expect(asked).toEqual(["cognito-client-secret"]);
  expect(signIn.cognito.clientSecret).toBe("managed-client-secret");
  expect(signIn.staffPinKeys).toBeNull();
  expect(await readPilotStaffSignInReadiness(directory, { env: pilot, readManaged })).toBe(
    "CognitoConfigured",
  );
  expect(
    await readPilotStaffSignInReadiness(directory, {
      env: pilot,
      readManaged: async () => undefined,
    }),
  ).toBe("NotConfigured");
  // A Pilot configuration may not name private secret files.
  await file(
    "staff-sign-in.json",
    JSON.stringify({ ...pilotConfig, cognito: { ...pilotCognito, clientSecretFile: "x" } }),
  );
  await expect(loadPilotStaffSignIn(directory, { env: pilot, readManaged })).rejects.toThrow();
});
