import { createPostgresMerchantOrganizationSource } from "../../packages/bop/tenant/src/index.ts";
import { createPostgresPublishedStoreOperatingStatusReader } from "../../packages/rms/store/src/index.ts";
import { currentPilotEnvironment } from "./pilot-environment.mjs";

/**
 * WP-2423 P1b (StoreOperatingSource): the Store's real operating facts for the pilot runtime.
 *
 * - The time zone is the Store's own record, never a constant.
 * - The live gate requirement codes a process insists on come from the installation profile.
 *   InternalTest keeps its synthetic gate by default; a Pilot Store must name real codes and may
 *   not name a synthetic one. Every publication proof re-checks them against the approved gate.
 * - Operating authorization is the installation binding's validity window, not "always allowed".
 * - A startup read of the published operating status fails fast before any traffic is served.
 */
const codePattern = /^[A-Z][A-Z0-9_]{2,63}$/u;
const instantPattern = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const fail = (code) => {
  throw new Error(code);
};

export function resolveOperatingConfiguration(profile, options = undefined) {
  const environment = currentPilotEnvironment(options);
  const declared = profile?.operating;
  if (declared === undefined) {
    if (environment === "InternalTest")
      return Object.freeze({ liveGateRequirementCodes: Object.freeze(["SYNTHETIC_STORE_READY"]) });
    return fail("PILOT_OPERATING_CONFIGURATION_REQUIRED");
  }
  if (
    !declared ||
    typeof declared !== "object" ||
    Array.isArray(declared) ||
    Object.keys(declared).join(",") !== "liveGateRequirementCodes" ||
    !Array.isArray(declared.liveGateRequirementCodes) ||
    declared.liveGateRequirementCodes.length === 0 ||
    declared.liveGateRequirementCodes.length > 100 ||
    declared.liveGateRequirementCodes.some((code) => !codePattern.test(code)) ||
    new Set(declared.liveGateRequirementCodes).size !== declared.liveGateRequirementCodes.length
  )
    return fail("PILOT_OPERATING_CONFIGURATION_INVALID");
  if (
    environment === "Pilot" &&
    declared.liveGateRequirementCodes.some((code) => code.startsWith("SYNTHETIC_"))
  )
    return fail("PILOT_OPERATING_CONFIGURATION_SYNTHETIC");
  return Object.freeze({
    liveGateRequirementCodes: Object.freeze([...declared.liveGateRequirementCodes]),
  });
}

/** Allowed exactly while the installation binding is valid at the observed instant. */
export function createBindingAuthorization(binding, now = () => new Date().toISOString()) {
  if (!instantPattern(binding?.validFrom) || !instantPattern(binding?.validUntil))
    return fail("PILOT_BINDING_INVALID");
  return async (...call) => {
    const at = call[1];
    const observed = at === undefined ? now() : at;
    return (
      instantPattern(observed) && observed >= binding.validFrom && observed < binding.validUntil
    );
  };
}

/** The Store record this installation is bound to: display name and IANA time zone. */
export async function readStoreOperatingFacts(transactions, scope, now) {
  const observedAt = now();
  if (!instantPattern(observedAt)) return fail("PILOT_STORE_RECORD_UNAVAILABLE");
  return transactions.run(async (tx) => {
    const organizations = createPostgresMerchantOrganizationSource(tx, {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      observedAt,
    });
    const store = await organizations.getStore(scope.storeReference);
    if (!store || typeof store.timeZone !== "string" || store.timeZone.length < 3)
      return fail("PILOT_STORE_RECORD_UNAVAILABLE");
    return Object.freeze({ displayName: store.displayName, timeZone: store.timeZone });
  });
}

/** Reads the published operating status once; a Store whose publication, live gate or time zone
 * does not line up refuses to start instead of failing on the first customer. */
export async function verifyStoreOperating(transactions, operating, now) {
  const at = now();
  const status = await transactions.run((tx) =>
    createPostgresPublishedStoreOperatingStatusReader(operating)(tx, at),
  );
  if (
    status.businessDate.brandReference !== operating.brandReference ||
    status.businessDate.storeReference !== operating.storeReference ||
    status.evaluatedAt !== at
  )
    return fail("PILOT_STORE_OPERATING_UNAVAILABLE");
  return Object.freeze({ businessDate: status.businessDate.businessDate, evaluatedAt: at });
}
