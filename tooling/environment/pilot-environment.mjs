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
    // WP-2423 DEC-COGNITO-STORE-STAFF: the Cognito sign-in is built; it closes this gap once the
    // installation's staff-sign-in.json selects it and its secret files are in place.
    needs:
      "Cognito workforce pool configured in staff-sign-in.json (external: AWS account, user pool, app client, domain, secrets)",
  }),
  Object.freeze({
    code: "Secrets",
    standIn: "locally generated internal-test keys",
    needs: "managed secret source for session, QR and cursor keys (with P4 hosting)",
  }),
  Object.freeze({
    code: "Tls",
    standIn: "local self-signed certificate",
    needs: "public certificate and reverse proxy (P4 hosting and domain)",
  }),
  Object.freeze({
    code: "PricingCurrencyMetadata",
    standIn: "TEST-ONLY synthetic CAD metadata",
    needs: "reviewed currency and tax configuration of the real Store (P5, tax review)",
  }),
]);

/**
 * The gaps that remain for this installation. WP-2423 DEC-COGNITO-STORE-STAFF: `StaffLogin`
 * closes only when the staff sign-in is configured for Cognito with every secret file present
 * and well formed (`readPilotStaffSignInReadiness`); a missing or broken configuration keeps it.
 */
export function currentPilotCapabilityGaps({ staffSignIn = "NotConfigured" } = {}) {
  return Object.freeze(
    pilotCapabilityGaps.filter(
      (gap) => !(gap.code === "StaffLogin" && staffSignIn === "CognitoConfigured"),
    ),
  );
}

/** Refuses a Pilot start while a capability gap remains; InternalTest is unaffected. */
export function assertPilotReady(options, capabilities = {}) {
  const environment = currentPilotEnvironment(options);
  const gaps = currentPilotCapabilityGaps(capabilities);
  if (environment === "Pilot" && gaps.length > 0)
    throw new Error("PILOT_CAPABILITY_MISSING:" + gaps.map((gap) => gap.code).join(","));
  return environment;
}
