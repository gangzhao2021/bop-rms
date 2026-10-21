import process from "node:process";

/**
 * WP-2423 P1b: which pilot runtime this process is. Two explicit environments:
 *
 * - InternalTest: a developer machine or test run (NODE_ENV development, or test where a caller
 *   admits it). Simulated payment, DEMO staff login, local self-signed TLS and generated test keys
 *   are available only here.
 * - Pilot: the real Store (NODE_ENV production with BOP_PILOT_ENVIRONMENT=Pilot). Nothing
 *   simulated is ever available; every configuration file must declare "Pilot".
 *
 * Any other combination is refused, so a production process never falls back to InternalTest.
 */
export const pilotEnvironments = Object.freeze(["InternalTest", "Pilot"]);

export function currentPilotEnvironment({ test = false, unset, env = process.env } = {}) {
  // `unset` keeps the historical InternalTest reading of an absent NODE_ENV as development.
  const node = env.NODE_ENV ?? (unset === "development" ? "development" : undefined),
    declared = env.BOP_PILOT_ENVIRONMENT;
  if (declared === "Pilot") {
    if (node === "production") return "Pilot";
  } else if (declared === undefined || declared === "InternalTest") {
    if (node === "development" || (test && node === "test")) return "InternalTest";
  }
  throw new Error("PILOT_ENVIRONMENT_INVALID");
}

/** Either environment: the shared business composition. */
export function isPilotRuntime(options) {
  try {
    currentPilotEnvironment(options);
    return true;
  } catch {
    return false;
  }
}

/** Simulation, DEMO login, self-signed TLS and generated test keys only. */
export function isInternalTest(options) {
  try {
    return currentPilotEnvironment(options) === "InternalTest";
  } catch {
    return false;
  }
}

/** The real Store environment: managed secrets, hosted certificate, no simulation. */
export function isPilotStore(options) {
  try {
    return currentPilotEnvironment(options) === "Pilot";
  } catch {
    return false;
  }
}

/**
 * DEC-STRIPE-PILOT-WIRING (Live): the Payment Provider environment every pilot composition path
 * uses. A Pilot Store accepts only Stripe live mode (payment.json `mode: "live"`), InternalTest only
 * the simulator or Stripe test mode, so the Provider environment follows the process environment;
 * the configured Stripe binding re-checks its own mode against this value. Never throws: any
 * process that is not a Pilot Store is "Test", and a Pilot Store can never run simulated.
 */
export function pilotProviderEnvironment(options) {
  return isPilotStore(options) ? "Live" : "Test";
}

/** A configuration file must declare the environment this process runs in. */
export function matchesPilotEnvironment(declared, options) {
  try {
    return declared === currentPilotEnvironment(options);
  } catch {
    return false;
  }
}

/** The process environment a supervised child service runs with. */
export function pilotChildEnvironment(environment) {
  if (environment === "InternalTest") return { NODE_ENV: "development" };
  if (environment === "Pilot") return { NODE_ENV: "production", BOP_PILOT_ENVIRONMENT: "Pilot" };
  throw new Error("PILOT_ENVIRONMENT_INVALID");
}

/**
 * WP-2423 P1b: what a Pilot Store still lacks. Each entry is an InternalTest stand-in that has no
 * Pilot implementation yet; it is removed here when its real implementation lands. A Pilot
 * process refuses to start while any remain, so nothing simulated can serve a real Store.
 */
export const pilotCapabilityGaps = Object.freeze([
  Object.freeze({
    code: "PaymentProvider",
    standIn: "internal payment simulator",
    // DEC-STRIPE-PILOT-WIRING: satisfied only by payment.json selecting Stripe in the mode of the
    // environment (live for a Pilot Store) with its live secret files present and well-formed
    // (pilotPaymentProviderReady); the Provider environment is "Live" through the composition.
    needs:
      "Stripe live mode in payment.json with the Owner's live keys and webhook signing secret (external: Stripe account, live webhook endpoint)",
    configurable: true,
  }),
  Object.freeze({
    code: "StaffLogin",
    standIn: "DEMO staff roster login",
    // DEC-COGNITO-STORE-STAFF: met when staff-sign-in.json selects Cognito and its client secret is
    // present (readPilotStaffSignInReadiness); the pool, client and domain are external.
    needs:
      "Cognito workforce pool configured in staff-sign-in.json (external: AWS account, user pool, app client, domain, client secret)",
    configurable: true,
  }),
  // DEC-PILOT-SECRETS: met when hosting.json names a secrets folder holding every managed value.
  Object.freeze({
    code: "Secrets",
    standIn: "locally generated internal-test keys",
    needs: "managed secret files from the hosting (hosting.json secretsDirectory; values external)",
    configurable: true,
  }),
  // DEC-PILOT-MAINTENANCE-PAGE: met with a public customer origin and a certificate phones trust.
  Object.freeze({
    code: "Tls",
    standIn: "local self-signed certificate",
    needs: "public customer domain and its certificate (hosting.json customerOrigin and tls)",
    configurable: true,
  }),
  Object.freeze({
    code: "PricingCurrencyMetadata",
    standIn: "TEST-ONLY synthetic CAD metadata",
    needs: "reviewed currency and tax configuration of the real Store (P5, tax review)",
  }),
]);

/**
 * The gaps that remain once this installation's checked configuration is taken into account. `met`
 * lists configurable gaps the configuration was checked to satisfy (never the others), e.g.
 * "Secrets"/"Tls" from `checkConfiguredPilotCapabilities` or "PaymentProvider" from
 * `pilotPaymentProviderReady`.
 */
export function remainingPilotCapabilityGaps(met = []) {
  const satisfied = new Set(met);
  return pilotCapabilityGaps.filter((gap) => !(gap.configurable && satisfied.has(gap.code)));
}

/** Refuses a Pilot start while a capability gap remains; InternalTest is unaffected. */
export function assertPilotReady(options = {}) {
  const environment = currentPilotEnvironment(options);
  const remaining = remainingPilotCapabilityGaps(options.met ?? []);
  if (environment === "Pilot" && remaining.length > 0)
    throw new Error("PILOT_CAPABILITY_MISSING:" + remaining.map((gap) => gap.code).join(","));
  return environment;
}

/**
 * Which configurable gaps this installation's hosting configuration satisfies, with a plain reason
 * for each one that is not (file names and fixed reasons only, never values).
 */
export async function checkConfiguredPilotCapabilities(
  runtimeDirectory,
  {
    loadHosting = async (directory) =>
      (await import("./pilot-hosting.mjs")).loadPilotHosting(directory),
    checkSecrets = async (directory) =>
      (await import("./pilot-secrets.mjs")).checkManagedSecrets(directory),
    checkTls = async (hosting) => (await import("./pilot-hosting.mjs")).checkPilotTls(hosting),
  } = {},
) {
  const met = [],
    problems = [];
  let hosting;
  try {
    hosting = await loadHosting(runtimeDirectory);
  } catch (error) {
    return { met, problems: [`hosting.json is unusable (${error?.reason ?? "unreadable"})`] };
  }
  if (hosting.secretsDirectory === null)
    problems.push("Secrets: no secretsDirectory in hosting.json");
  else {
    const result = await checkSecrets(hosting.secretsDirectory);
    if (result.missing.length === 0 && result.invalid.length === 0) met.push("Secrets");
    else {
      const { describeSecretProblems } = await import("./pilot-secrets.mjs");
      problems.push("Secrets: " + describeSecretProblems(result));
    }
  }
  const tls = await checkTls(hosting);
  if (tls === null) met.push("Tls");
  else problems.push("Tls: " + tls);
  return { met, problems };
}
