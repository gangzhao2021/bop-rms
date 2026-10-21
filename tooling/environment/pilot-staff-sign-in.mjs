import { Buffer } from "node:buffer";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { parseExactHttpsUri, readClosedRecord } from "../../packages/bop/identity/src/index.ts";
import {
  createPrivateInstallationReader,
  parsePrivateInstallationFilename,
} from "./private-installation-files.mjs";
import { currentPilotEnvironment, matchesPilotEnvironment } from "./pilot-environment.mjs";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF: how this pilot installation's staff sign in.
 *
 * Without `staff-sign-in.json` (or with `"mode": "internal-test"`) staff use the TEST-ONLY
 * internal sign-in page and the TEST-ONLY authenticator step-up, and the PIN keys are derived from
 * the internal test key file, exactly as before. With `"mode": "cognito"` staff sign in with
 * their own Amazon Cognito account (managed login, password and authenticator every time), step
 * up by signing in again, are invited in the app, and the PIN pepper and tablet keys come from
 * their own secret files. Secrets live only in owner-only files in the private runtime directory
 * and are never logged or returned; a missing or malformed file refuses to start.
 *
 * {
 *   "schemaVersion": 1,
 *   "environment": "InternalTest" | "Pilot",
 *   "mode": "cognito",
 *   "exactOrigin": "https://<staff origin>",
 *   "cognito": {
 *     "bindingEnvironment": "<a-z0-9- code, e.g. bop-pilot>",
 *     "issuer": "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_<pool>",
 *     "clientId": "<app client id>",
 *     "managedLoginOrigin": "https://<prefix>.auth.ca-central-1.amazoncognito.com",
 *     "clientSecretFile": "cognito-client-secret"
 *   },
 *   "staffPin": {
 *     "pepperFile": "staff-pin-pepper",
 *     "deviceKeyFile": "store-device-key",
 *     "choiceKeyFile": "staff-pin-choice-key"
 *   },
 *   "testProvider": { "origin": "http://127.0.0.1:<port>" }   // InternalTest only, TEST-ONLY
 * }
 */
export const staffSignInFileName = "staff-sign-in.json";
const unavailable = () => new Error("PILOT_STAFF_SIGN_IN_UNAVAILABLE");
const keyPattern = /^[a-f0-9]{64}$/u;
const awsIdp = "https://cognito-idp.ca-central-1.amazonaws.com";

function exactOrigin(value) {
  const parsed = new URL(parseExactHttpsUri(value));
  if (value !== parsed.origin || parsed.pathname !== "/" || parsed.search || parsed.hash)
    throw unavailable();
  return parsed;
}
async function key(read, name) {
  const text = (await read(parsePrivateInstallationFilename(name))).trim();
  if (!keyPattern.test(text)) throw unavailable();
  return Buffer.from(text, "hex");
}

/**
 * The installation's staff sign-in. `{ mode: "internal-test" }` when not configured; otherwise
 * the Cognito configuration with its secrets read now (callers must not log the result).
 */
export async function loadPilotStaffSignIn(directory, { env } = {}) {
  const reader = await createPrivateInstallationReader(directory);
  let text;
  try {
    text = await reader.read(staffSignInFileName);
  } catch {
    // Absent: the InternalTest sign-in. Present but unreadable (mode, owner, link): refused.
    try {
      await lstat(join(directory, staffSignInFileName));
    } catch (missing) {
      if (missing?.code === "ENOENT") return Object.freeze({ mode: "internal-test" });
    }
    throw unavailable();
  }
  try {
    const raw = JSON.parse(text);
    const mode = raw?.mode;
    if (mode === "internal-test") {
      readClosedRecord(raw, ["schemaVersion", "environment", "mode"]);
      if (raw.schemaVersion !== 1 || !matchesPilotEnvironment(raw.environment, { test: true, env }))
        throw unavailable();
      return Object.freeze({ mode: "internal-test" });
    }
    const config = readClosedRecord(raw, [
      "schemaVersion",
      "environment",
      "mode",
      "exactOrigin",
      "cognito",
      "staffPin",
      ...(Object.hasOwn(raw, "testProvider") ? ["testProvider"] : []),
    ]);
    if (
      config.schemaVersion !== 1 ||
      config.mode !== "cognito" ||
      !matchesPilotEnvironment(config.environment, { test: true, env })
    )
      throw unavailable();
    const origin = exactOrigin(config.exactOrigin);
    const cognito = readClosedRecord(config.cognito, [
      "bindingEnvironment",
      "issuer",
      "clientId",
      "managedLoginOrigin",
      "clientSecretFile",
    ]);
    const issuer = parseExactHttpsUri(cognito.issuer);
    if (
      typeof cognito.bindingEnvironment !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(cognito.bindingEnvironment) ||
      issuer !== cognito.issuer ||
      !/^https:\/\/cognito-idp\.ca-central-1\.amazonaws\.com\/ca-central-1_[A-Za-z0-9]{1,42}$/u.test(
        issuer,
      ) ||
      typeof cognito.clientId !== "string" ||
      !/^[a-z0-9]{1,128}$/u.test(cognito.clientId)
    )
      throw unavailable();
    const managedLogin = exactOrigin(cognito.managedLoginOrigin);
    const pin = readClosedRecord(config.staffPin, ["pepperFile", "deviceKeyFile", "choiceKeyFile"]);
    const files = [cognito.clientSecretFile, pin.pepperFile, pin.deviceKeyFile, pin.choiceKeyFile];
    if (
      files.some((name) => typeof name !== "string") ||
      new Set(files).size !== files.length ||
      files.includes(staffSignInFileName)
    )
      throw unavailable();
    files.forEach(parsePrivateInstallationFilename);
    const clientSecret = (await reader.read(cognito.clientSecretFile)).trim();
    if (!/^[\x21-\x7e]{1,256}$/u.test(clientSecret)) throw unavailable();
    const pepper = await key(reader.read, pin.pepperFile),
      device = await key(reader.read, pin.deviceKeyFile),
      choice = await key(reader.read, pin.choiceKeyFile);
    if (pepper.equals(device) || pepper.equals(choice) || device.equals(choice))
      throw unavailable();
    let testProvider = null;
    if (Object.hasOwn(config, "testProvider")) {
      // TEST-ONLY: a loopback Cognito stand-in, never in a Pilot (production) process.
      if (
        config.environment !== "InternalTest" ||
        currentPilotEnvironment({ test: true, env }) !== "InternalTest"
      )
        throw unavailable();
      const value = readClosedRecord(config.testProvider, [
        "origin",
        ...(Object.hasOwn(config.testProvider ?? {}, "browserOrigin") ? ["browserOrigin"] : []),
      ]);
      const loopback = (text, protocol) => {
        const parsed = new URL(String(text));
        if (
          parsed.protocol !== protocol ||
          parsed.hostname !== "127.0.0.1" ||
          !parsed.port ||
          parsed.origin !== text
        )
          throw unavailable();
        return parsed.origin;
      };
      testProvider = Object.freeze({
        origin: loopback(value.origin, "http:"),
        // The browser needs HTTPS (the sign-in start only follows an https:// address).
        browserOrigin:
          value.browserOrigin === undefined ? null : loopback(value.browserOrigin, "https:"),
      });
    }
    return Object.freeze({
      mode: "cognito",
      environment: config.environment,
      exactOrigin: origin.origin,
      acceptedHost: origin.host,
      cognito: Object.freeze({
        environment: cognito.bindingEnvironment,
        issuer,
        clientId: cognito.clientId,
        clientSecret,
        managedLoginOrigin: managedLogin.origin,
      }),
      staffPinKeys: Object.freeze({ pepper, device, choice }),
      testProvider,
    });
  } catch {
    throw unavailable();
  }
}

/**
 * WP-2423 P1b capability check: `CognitoConfigured` only when the installation selects Cognito
 * and every secret file is present and well formed. Nothing secret is returned.
 */
export async function readPilotStaffSignInReadiness(directory, options = {}) {
  try {
    const signIn = await loadPilotStaffSignIn(directory, options);
    if (signIn.mode !== "cognito") return "NotConfigured";
    for (const value of Object.values(signIn.staffPinKeys)) value.fill(0);
    return signIn.testProvider === null ? "CognitoConfigured" : "NotConfigured";
  } catch {
    return "NotConfigured";
  }
}

/**
 * TEST-ONLY (InternalTest): routes the server's Provider calls (token, revocation, JWKS, and the
 * admin API) to the loopback stand-in instead of AWS. Any other URL is refused.
 */
export function createTestProviderFetch(signIn, base = globalThis.fetch) {
  if (signIn.mode !== "cognito" || signIn.testProvider === null) throw unavailable();
  const login = signIn.cognito.managedLoginOrigin;
  const target = signIn.testProvider.origin;
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== login && url.origin !== awsIdp) throw unavailable();
    const response = await base(target + url.pathname + url.search, init);
    // Answered as if from the requested address (the adapter refuses a redirected response).
    return new globalThis.Response(await response.arrayBuffer(), {
      status: response.status,
      headers: response.headers,
    });
  };
}
/** TEST-ONLY (InternalTest): the browser goes to the loopback stand-in's sign-in page. */
export function testProviderAuthorizationUrl(signIn, authorizationUrl) {
  if (signIn.mode !== "cognito" || signIn.testProvider?.browserOrigin == null)
    return authorizationUrl;
  const url = new URL(authorizationUrl);
  if (url.origin !== signIn.cognito.managedLoginOrigin) throw unavailable();
  return signIn.testProvider.browserOrigin + url.pathname + url.search;
}
