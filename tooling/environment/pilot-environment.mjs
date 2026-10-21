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
    needs: "Stripe adapter wiring (repository) and the Owner's Stripe account keys (external)",
  }),
  Object.freeze({
    code: "StaffLogin",
    standIn: "DEMO staff roster login",
    needs: "Cognito workforce pool (external: AWS account, user pool, app client, domain)",
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
 * Refuses a Pilot start while a capability gap remains; InternalTest is unaffected. `met` lists
 * configurable gaps this installation's configuration was checked to satisfy (never the others).
 */
export function assertPilotReady(options = {}) {
  const environment = currentPilotEnvironment(options);
  const met = new Set(options.met ?? []);
  const remaining = pilotCapabilityGaps.filter((gap) => !(gap.configurable && met.has(gap.code)));
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
