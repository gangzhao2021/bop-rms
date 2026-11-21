// WP-2423 DEC-STRIPE-PILOT-WIRING: which payment Provider this pilot installation uses,
// `<runtime>/payment.json`. Absent → the TEST-ONLY internal simulator (InternalTest only).
// Stripe keys and webhook signing secrets live in separate private files (0600) named here;
// they are read on use, never copied into this file, logs, messages or process environment.
import path from "node:path";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { readPrivateJson } from "./pilot-ops-files.mjs";
import { readPilotSecret } from "./pilot-ops-config.mjs";

export const PAYMENT_CONFIG_FILE = "payment.json";
/** The public webhook route served by the pilot API (apps/api payment-provider-webhook). */
export const STRIPE_WEBHOOK_PATH = "/api/v1/payment-provider/stripe/webhook";
/** Event types the pilot consumes; the Stripe webhook endpoint must send at least these. */
export const STRIPE_WEBHOOK_EVENTS = Object.freeze([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);

const fail = (reason) => {
  throw Object.assign(Error("PILOT_PAYMENT_CONFIG_INVALID"), { reason });
};
const exactKeys = (value, required, optional, reason) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(reason);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    return fail(reason);
  return value;
};
const FILE_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const fileName = (value, reason) =>
  typeof value === "string" && FILE_NAME.test(value) && !value.includes("..")
    ? value
    : fail(reason);
const instant = (value, reason) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  new Date(value).toISOString() === value
    ? value
    : fail(reason);
const httpsUrl = (value, reason, { path: requiredPath } = {}) => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (requiredPath !== undefined && url.pathname !== requiredPath)
    )
      return fail(reason);
    return url.href;
  } catch {
    return fail(reason);
  }
};
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/**
 * Parses payment.json. `environment` is the process environment ("InternalTest" | "Pilot").
 * Simulation and Stripe test mode are InternalTest only; Stripe live mode is Pilot only, and the
 * publishable/secret keys must carry the configured mode's prefix (DEC-STRIPE-PILOT-WIRING, Live).
 */
export function parsePilotPaymentConfig(value, { environment }) {
  if (value === null) {
    if (environment !== "InternalTest") fail("provider.missing");
    return Object.freeze({ provider: "simulated" });
  }
  const config = exactKeys(value, ["schemaVersion", "provider"], ["stripe"], "keys");
  if (config.schemaVersion !== 1) fail("schemaVersion");
  if (config.provider === "simulated") {
    if (config.stripe !== undefined) fail("stripe.unexpected");
    if (environment !== "InternalTest") fail("provider.simulated-internal-test-only");
    return Object.freeze({ provider: "simulated" });
  }
  if (config.provider !== "stripe") fail("provider");
  const s = exactKeys(
    config.stripe,
    [
      "mode",
      "apiVersion",
      "publishableKey",
      "secretKeyFile",
      "webhookSecretFile",
      "returnUrl",
      "webhookUrl",
    ],
    [
      "nextWebhookSecret",
      "connectedAccount",
      "paymentMethodDomain",
      "walletsEnabled",
      "captureLookbackDays",
      "testApiBaseUrl",
    ],
    "stripe",
  );
  // A Pilot Store takes real money: live mode only. InternalTest never touches live mode.
  if (s.mode !== "test" && s.mode !== "live") fail("stripe.mode");
  if (s.mode === "live" && environment !== "Pilot") fail("stripe.mode.live-pilot-only");
  if (s.mode === "test" && environment !== "InternalTest")
    fail("stripe.mode.test-internal-test-only");
  if (typeof s.apiVersion !== "string" || !/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/u.test(s.apiVersion))
    fail("stripe.apiVersion");
  if (
    typeof s.publishableKey !== "string" ||
    !new RegExp("^pk_" + s.mode + "_[A-Za-z0-9]+$", "u").test(s.publishableKey)
  )
    fail("stripe.publishableKey");
  let next = null;
  if (s.nextWebhookSecret !== undefined && s.nextWebhookSecret !== null) {
    const n = exactKeys(
      s.nextWebhookSecret,
      ["file", "validFrom", "validUntil"],
      [],
      "stripe.nextWebhookSecret",
    );
    next = Object.freeze({
      file: fileName(n.file, "stripe.nextWebhookSecret.file"),
      validFrom: instant(n.validFrom, "stripe.nextWebhookSecret.validFrom"),
      validUntil: instant(n.validUntil, "stripe.nextWebhookSecret.validUntil"),
    });
    const span = Date.parse(next.validUntil) - Date.parse(next.validFrom);
    if (span < 0 || span > 7 * 86_400_000) fail("stripe.nextWebhookSecret.window");
  }
  const connectedAccount =
    s.connectedAccount === undefined || s.connectedAccount === null
      ? null
      : typeof s.connectedAccount === "string" && /^acct_[A-Za-z0-9]+$/u.test(s.connectedAccount)
        ? s.connectedAccount
        : fail("stripe.connectedAccount");
  const returnUrl = httpsUrl(s.returnUrl, "stripe.returnUrl");
  const webhookUrl = httpsUrl(s.webhookUrl, "stripe.webhookUrl", { path: STRIPE_WEBHOOK_PATH });
  if (new URL(returnUrl).hostname === new URL(webhookUrl).hostname)
    // The return page must be a separate sanitizer origin: Stripe appends the client credential.
    fail("stripe.returnUrl.same-origin");
  const paymentMethodDomain =
    s.paymentMethodDomain === undefined || s.paymentMethodDomain === null
      ? null
      : typeof s.paymentMethodDomain === "string" && DOMAIN.test(s.paymentMethodDomain)
        ? s.paymentMethodDomain
        : fail("stripe.paymentMethodDomain");
  // Apple Pay / Google Pay show only after the operator confirmed the wallet domain is registered
  // and verified with Stripe (`pilot-stripe-operations check`); never without a configured domain.
  const walletsEnabled = s.walletsEnabled ?? false;
  if (typeof walletsEnabled !== "boolean") fail("stripe.walletsEnabled");
  if (walletsEnabled && paymentMethodDomain === null) fail("stripe.walletsEnabled.domain-missing");
  const captureLookbackDays = s.captureLookbackDays ?? 7;
  if (
    !Number.isSafeInteger(captureLookbackDays) ||
    captureLookbackDays < 1 ||
    captureLookbackDays > 35
  )
    fail("stripe.captureLookbackDays");
  let testApiBaseUrl = null;
  if (s.testApiBaseUrl !== undefined && s.testApiBaseUrl !== null) {
    // TEST-ONLY: the local Stripe stand-in (pilot-stripe-fake.mjs) on loopback, InternalTest only.
    if (environment !== "InternalTest") fail("stripe.testApiBaseUrl.internal-test-only");
    try {
      const url = new URL(s.testApiBaseUrl);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        fail("stripe.testApiBaseUrl");
      testApiBaseUrl = url.origin;
    } catch {
      fail("stripe.testApiBaseUrl");
    }
  }
  return Object.freeze({
    provider: "stripe",
    stripe: Object.freeze({
      mode: s.mode,
      environment: s.mode === "live" ? "Live" : "Test",
      apiVersion: s.apiVersion,
      publishableKey: s.publishableKey,
      secretKeyFile: fileName(s.secretKeyFile, "stripe.secretKeyFile"),
      webhookSecretFile: fileName(s.webhookSecretFile, "stripe.webhookSecretFile"),
      nextWebhookSecret: next,
      connectedAccount,
      returnUrl,
      webhookUrl,
      paymentMethodDomain,
      walletsEnabled,
      captureLookbackDays,
      testApiBaseUrl,
    }),
  });
}
export async function loadPilotPaymentConfig(runtimeDirectory, { environment }) {
  return parsePilotPaymentConfig(
    await readPrivateJson(path.join(runtimeDirectory, PAYMENT_CONFIG_FILE)),
    { environment },
  );
}
/**
 * The Stripe secret API key of the configured mode (sk_test_/rk_test_ or sk_live_/rk_live_), read
 * from its private file on each use. A key of the other mode is refused.
 */
export async function readStripeSecretKey(runtimeDirectory, stripe) {
  if (stripe.mode !== "test" && stripe.mode !== "live") throw Error("PILOT_STRIPE_MODE_INVALID");
  const key = await readPilotSecret(runtimeDirectory, stripe.secretKeyFile);
  if (!new RegExp("^(?:sk|rk)_" + stripe.mode + "_[A-Za-z0-9]+$", "u").test(key))
    throw Error("PILOT_STRIPE_SECRET_KEY_INVALID");
  return key;
}
/** Webhook signing secrets as owned bytes (the verifier zeroes them after use). */
export async function readStripeWebhookSecrets(runtimeDirectory, stripe) {
  const secret = async (file) => {
    const value = await readPilotSecret(runtimeDirectory, file);
    if (!/^whsec_[A-Za-z0-9+/=_-]{16,200}$/u.test(value))
      throw Error("PILOT_STRIPE_WEBHOOK_SECRET_INVALID");
    return new Uint8Array(Buffer.from(value, "utf8"));
  };
  return {
    currentSecret: await secret(stripe.webhookSecretFile),
    nextSecret:
      stripe.nextWebhookSecret === null
        ? null
        : {
            secret: await secret(stripe.nextWebhookSecret.file),
            validFrom: stripe.nextWebhookSecret.validFrom,
            validUntil: stripe.nextWebhookSecret.validUntil,
          },
  };
}
/**
 * DEC-STRIPE-PILOT-WIRING: the "PaymentProvider" capability is satisfied only by a configured
 * Stripe Provider whose secret files are present and whose mode fits the environment: test mode
 * serves InternalTest; a Pilot Store needs live mode (the parser refuses any other pairing).
 */
export async function pilotPaymentProviderReady(runtimeDirectory, { environment }) {
  try {
    const config = await loadPilotPaymentConfig(runtimeDirectory, { environment });
    if (config.provider !== "stripe") return false;
    if (config.stripe.mode !== (environment === "Pilot" ? "live" : "test")) return false;
    return await stripeSecretsPresent(runtimeDirectory, config.stripe);
  } catch {
    return false;
  }
}
/** True when every secret file the Stripe configuration names is present and well-formed. */
export async function stripeSecretsPresent(runtimeDirectory, stripe) {
  try {
    await readStripeSecretKey(runtimeDirectory, stripe);
    const secrets = await readStripeWebhookSecrets(runtimeDirectory, stripe);
    secrets.currentSecret.fill(0);
    secrets.nextSecret?.secret.fill(0);
    return true;
  } catch {
    return false;
  }
}
