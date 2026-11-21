import console from "node:console";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL, URLSearchParams } from "node:url";
import { createStripeOnlineTransport } from "../../packages/rms/payment/src/index.ts";
import { currentPilotEnvironment } from "./pilot-environment.mjs";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import {
  loadPilotPaymentConfig,
  readStripeSecretKey,
  STRIPE_WEBHOOK_EVENTS,
  stripeSecretsPresent,
} from "./pilot-payment-config.mjs";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";

/**
 * WP-2423 DEC-STRIPE-PILOT-WIRING: the operator's Stripe tool for one pilot installation.
 *
 *   check           <runtime-dir>                                  read-only readiness report
 *   register-domain <runtime-dir> [--apply --confirm-target <domain>]
 *
 * `check` reads the account, webhook endpoints and payment method domain with the configured
 * secret key and reports each item as ok/fail/skipped: key mode (test/live), account can charge
 * in CAD, a webhook endpoint for this installation's URL is enabled with the required events and
 * the pinned API version, and the wallet domain is registered. `register-domain` is a dry run
 * unless --apply and --confirm-target naming the configured domain are both given. Output never
 * contains keys, signing secrets, client credentials or full Provider account IDs.
 */
const STRIPE_BASE = "https://api.stripe.com";
const loopbackFetch = (base) => (input, init) => {
  const target = String(input);
  if (!target.startsWith(STRIPE_BASE + "/")) throw Error("PILOT_STRIPE_ORIGIN_UNEXPECTED");
  return globalThis.fetch(base + target.slice(STRIPE_BASE.length), init);
};
const tail = (value) => (typeof value === "string" ? "…" + value.slice(-4) : null);

async function connect({ directory, environment, loadProfile, fetch }) {
  const config = await loadPilotPaymentConfig(directory, { environment });
  if (config.provider !== "stripe") return { config, transport: null, scope: null };
  const profile = await loadProfile();
  const scope = {
    brandReference: profile.binding.brandReference,
    storeReference: profile.binding.storeReference,
    environment: config.stripe.environment,
  };
  const transport = createStripeOnlineTransport({
    ...scope,
    apiVersion: config.stripe.apiVersion,
    secretKey: await readStripeSecretKey(directory, config.stripe),
    connectedAccount: config.stripe.connectedAccount,
    ...(fetch !== undefined
      ? { fetch }
      : config.stripe.testApiBaseUrl !== null
        ? { fetch: loopbackFetch(config.stripe.testApiBaseUrl) }
        : {}),
  });
  return { config, transport, scope };
}

export async function runStripeReadinessCheck({ directory, environment, loadProfile, fetch }) {
  const items = [];
  const add = (check, status, detail = null) => items.push({ check, status, detail });
  let connected;
  try {
    connected = await connect({ directory, environment, loadProfile, fetch });
  } catch (error) {
    add("configuration", "fail", error?.reason ?? "PILOT_PAYMENT_CONFIG_UNREADABLE");
    return { ok: false, items };
  }
  const { config, transport, scope } = connected;
  if (config.provider !== "stripe") {
    add("configuration", "fail", "provider is the TEST-ONLY simulator (no payment.json)");
    return { ok: false, items };
  }
  const stripe = config.stripe;
  add("configuration", "ok", "Stripe " + stripe.mode + " mode, API version " + stripe.apiVersion);
  add(
    "secret-files",
    (await stripeSecretsPresent(directory, stripe)) ? "ok" : "fail",
    "secret key and webhook signing secret files (0600)",
  );
  add(
    "key-mode",
    "ok",
    stripe.mode === "live"
      ? "live keys (sk_live_/rk_live_, pk_live_) for this Pilot Store"
      : "test keys (sk_test_/rk_test_, pk_test_); live keys are Pilot only",
  );
  if (stripe.testApiBaseUrl !== null)
    add("api-endpoint", "ok", "TEST-ONLY local Stripe stand-in on loopback");
  const read = async (resource) => {
    const response = await transport.read(scope, resource);
    if (response.status !== 200) throw Error("HTTP_" + response.status);
    return response.payload;
  };
  try {
    const account = await read("/v1/account");
    add(
      "account",
      account.charges_enabled === true && account.default_currency === "cad" ? "ok" : "fail",
      "account " +
        tail(account.id) +
        ", charges " +
        (account.charges_enabled === true ? "enabled" : "disabled") +
        ", currency " +
        String(account.default_currency),
    );
  } catch (error) {
    add("account", "fail", "account unreadable: " + error.message);
  }
  try {
    const list = await read("/v1/webhook_endpoints?limit=100");
    const endpoint = (list.data ?? []).find((entry) => entry.url === stripe.webhookUrl);
    if (endpoint === undefined)
      add("webhook-endpoint", "fail", "no endpoint for " + stripe.webhookUrl);
    else {
      const events = endpoint.enabled_events ?? [];
      const missing = events.includes("*")
        ? []
        : STRIPE_WEBHOOK_EVENTS.filter((event) => !events.includes(event));
      const modeMatches = endpoint.livemode === (stripe.mode === "live");
      add(
        "webhook-endpoint",
        endpoint.status === "enabled" && missing.length === 0 && modeMatches ? "ok" : "fail",
        "status " +
          endpoint.status +
          (missing.length === 0 ? ", events complete" : ", missing " + missing.join(" ")) +
          (modeMatches ? "" : ", endpoint is not a " + stripe.mode + "-mode endpoint"),
      );
      add(
        "webhook-api-version",
        endpoint.api_version === stripe.apiVersion ? "ok" : "fail",
        "endpoint " + String(endpoint.api_version) + ", pinned " + stripe.apiVersion,
      );
    }
  } catch (error) {
    add("webhook-endpoint", "fail", "webhook endpoints unreadable: " + error.message);
  }
  if (stripe.paymentMethodDomain === null)
    add("payment-method-domain", "skipped", "no paymentMethodDomain configured (wallets stay off)");
  else
    try {
      const list = await read(
        "/v1/payment_method_domains?" +
          new URLSearchParams({ domain_name: stripe.paymentMethodDomain }).toString(),
      );
      const domain = (list.data ?? [])[0];
      add(
        "payment-method-domain",
        domain?.enabled === true && domain.apple_pay?.status === "active" ? "ok" : "fail",
        domain === undefined
          ? stripe.paymentMethodDomain + " not registered (run register-domain)"
          : stripe.paymentMethodDomain +
              " apple_pay " +
              String(domain.apple_pay?.status) +
              ", google_pay " +
              String(domain.google_pay?.status),
      );
    } catch (error) {
      add("payment-method-domain", "fail", "domains unreadable: " + error.message);
    }
  // Customers see Apple Pay / Google Pay only with walletsEnabled; it must not be on while the
  // domain is not registered and verified, or wallets would silently disappear for customers.
  const domainItem = items.find((item) => item.check === "payment-method-domain");
  if (stripe.walletsEnabled === true)
    add(
      "wallets",
      domainItem?.status === "ok" ? "ok" : "fail",
      domainItem?.status === "ok"
        ? "Apple Pay / Google Pay shown on " + stripe.paymentMethodDomain
        : "walletsEnabled is on but the domain is not verified; turn it off or fix the domain",
    );
  else
    add(
      "wallets",
      "skipped",
      "card only; set walletsEnabled after the payment-method-domain check passes",
    );
  return { ok: items.every((item) => item.status !== "fail"), items };
}

export async function registerStripePaymentMethodDomain({
  directory,
  environment,
  loadProfile,
  fetch,
  apply = false,
  confirmTarget = null,
}) {
  const { config, transport, scope } = await connect({
    directory,
    environment,
    loadProfile,
    fetch,
  });
  if (config.provider !== "stripe") throw Error("PILOT_STRIPE_NOT_CONFIGURED");
  const domain = config.stripe.paymentMethodDomain;
  if (domain === null) throw Error("PILOT_STRIPE_DOMAIN_NOT_CONFIGURED");
  if (!apply) return { applied: false, plan: "POST /v1/payment_method_domains " + domain };
  if (confirmTarget !== domain) throw Error("PILOT_STRIPE_DOMAIN_NOT_CONFIRMED");
  const response = await transport.registerPaymentMethodDomain(scope, domain);
  if (response.status !== 200) throw Error("PILOT_STRIPE_DOMAIN_REGISTRATION_FAILED");
  return {
    applied: true,
    domain,
    applePay: response.payload?.apple_pay?.status ?? null,
    googlePay: response.payload?.google_pay?.status ?? null,
  };
}

export function parseStripeOperationsArguments(args) {
  const [command, directory, ...rest] = args;
  if (!["check", "register-domain"].includes(command) || typeof directory !== "string")
    throw Error("usage: pilot-stripe-operations check|register-domain <runtime-dir>");
  const runtime = parsePilotRuntimeDirectory(directory);
  if (command === "check") {
    if (rest.length !== 0) throw Error("usage: pilot-stripe-operations check <runtime-dir>");
    return { command, directory: runtime };
  }
  if (rest.length === 0) return { command, directory: runtime, apply: false, confirmTarget: null };
  if (rest.length === 3 && rest[0] === "--apply" && rest[1] === "--confirm-target")
    return { command, directory: runtime, apply: true, confirmTarget: rest[2] };
  throw Error(
    "usage: pilot-stripe-operations register-domain <runtime-dir> [--apply --confirm-target <domain>]",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = parseStripeOperationsArguments(process.argv.slice(2));
    const directory = path.join(
      fileURLToPath(new URL("../../", import.meta.url)),
      parsed.directory,
    );
    const installation = await loadPilotInstallation(directory);
    const options = {
      directory,
      environment: currentPilotEnvironment(),
      loadProfile: installation.loadProfile,
    };
    if (parsed.command === "check") {
      const report = await runStripeReadinessCheck(options);
      for (const item of report.items) console.log(JSON.stringify(item));
      process.exitCode = report.ok ? 0 : 1;
    } else
      console.log(
        JSON.stringify(
          await registerStripePaymentMethodDomain({
            ...options,
            apply: parsed.apply,
            confirmTarget: parsed.confirmTarget,
          }),
        ),
      );
  } catch (error) {
    console.error(
      String(error?.message ?? "").match(/^(PILOT_[A-Z_]+|usage: .*)$/u)?.[0] ??
        "PILOT_STRIPE_OPERATION_UNAVAILABLE",
    );
    process.exitCode = 1;
  }
}
