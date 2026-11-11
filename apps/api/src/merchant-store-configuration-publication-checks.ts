import { readClosedRecord } from "@bop/identity";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
  type StoreConfigurationVersion,
} from "@rms/store";

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: what must hold before a Store configuration created from
 * Store setup may be sent for approval, approved and published. Every check blocks; the screen
 * lists them in plain words so the Owner sees what to fix and where. The saved address, contact,
 * payment and receipt settings are read again from their owners when the configuration is sent
 * for approval (they are append-only, chosen from saved versions, and cannot vanish).
 *
 * DEC-STORE-PHONE-BEFORE-PICKUP (M109): V2 appends `StorePhone` (a configuration that offers pickup
 * needs the Store's published phone). V1 lists, read back from earlier answers, stay readable.
 */
export const storeConfigurationPublicationCheckCodesV1 = Object.freeze([
  "Tax",
  "BrandSettings",
  "TimeZone",
  "BusinessDayStart",
  "Hours",
  "EffectiveDate",
  "Fees",
  "GoLive",
] as const);
export const storeConfigurationPublicationCheckCodes = Object.freeze([
  ...storeConfigurationPublicationCheckCodesV1,
  "StorePhone",
] as const);
export type StoreConfigurationPublicationCheckCode =
  (typeof storeConfigurationPublicationCheckCodes)[number];
export interface StoreConfigurationPublicationCheck {
  readonly code: StoreConfigurationPublicationCheckCode;
  readonly outcome: "Pass" | "Fail";
}
type ChecksProfile =
  "StoreConfigurationPublicationChecksV1" | "StoreConfigurationPublicationChecksV2";
const codesOf = (profile: ChecksProfile): readonly StoreConfigurationPublicationCheckCode[] =>
  profile === "StoreConfigurationPublicationChecksV1"
    ? storeConfigurationPublicationCheckCodesV1
    : storeConfigurationPublicationCheckCodes;
export interface StoreConfigurationPublicationChecks {
  readonly profile: ChecksProfile;
  readonly configurationReference: string;
  readonly checkedAt: string;
  readonly checks: readonly StoreConfigurationPublicationCheck[];
}
/** Facts read from their owners in the caller's transaction (never from the browser). */
export interface StoreConfigurationPublicationFacts {
  /** The tax configuration that currently governs the Store, or null when none (or several). */
  readonly tax: {
    readonly configurationReference: string;
    readonly currencyCode: string;
    readonly evidenceValidUntil: string;
  } | null;
  /** The Store's go-live check (Live Gate) is approved for the codes this deployment requires. */
  readonly goLive: boolean;
  /** M109: the Store's current published profile has a phone pickup guests can call (read only
   * when the configuration starts offering pickup; otherwise not consulted). */
  readonly storePhone: boolean;
}

/** M109: the configuration offers pickup and the one in force does not (or there is none). */
export const storeConfigurationStartsPickup = (
  configuration: Pick<StoreConfigurationVersion, "enabledServiceModes">,
  current: Pick<StoreConfigurationVersion, "enabledServiceModes"> | null,
) =>
  configuration.enabledServiceModes.includes("Pickup") &&
  !(current?.enabledServiceModes.includes("Pickup") ?? false);

const fixedOrder = (results: Readonly<Record<StoreConfigurationPublicationCheckCode, boolean>>) =>
  Object.freeze(
    storeConfigurationPublicationCheckCodes.map((code) =>
      Object.freeze({ code, outcome: results[code] ? ("Pass" as const) : ("Fail" as const) }),
    ),
  );

/** Pure: the configuration, the currently published one, the Store's time zone on record and the
 * owner facts. Hours, dates and fees are structural; the rest compare against current facts. */
export function evaluateStoreConfigurationPublication(input: {
  readonly configuration: StoreConfigurationVersion;
  readonly current: StoreConfigurationVersion | null;
  readonly storeTimeZone: string;
  readonly observedAt: string;
  readonly facts: StoreConfigurationPublicationFacts;
}): StoreConfigurationPublicationChecks {
  const configuration = createStoreConfigurationVersion(input.configuration),
    current = input.current === null ? null : createStoreConfigurationVersion(input.current),
    at = parseCanonicalInstant(input.observedAt),
    facts = input.facts;
  // At least one opening period a week, each using only service modes the Store offers (the same
  // rule publication enforces on the published configuration).
  const hours =
    configuration.enabledServiceModes.length > 0 &&
    configuration.weeklySchedule.some((day) => day.intervals.length > 0) &&
    [...configuration.weeklySchedule, ...configuration.exceptions].every((day) =>
      day.intervals.every((entry) =>
        entry.serviceModes.every((mode) => configuration.enabledServiceModes.includes(mode)),
      ),
    );
  const basis = configuration.setupBasis;
  return Object.freeze({
    profile: "StoreConfigurationPublicationChecksV2",
    configurationReference: configuration.configurationReference,
    checkedAt: at,
    checks: fixedOrder({
      Tax:
        facts.tax !== null &&
        facts.tax.configurationReference === configuration.taxConfigurationReference &&
        facts.tax.currencyCode === configuration.currencyCode &&
        facts.tax.evidenceValidUntil > at,
      // Brand settings are not changed in Store setup: they stay those of the live configuration.
      BrandSettings:
        current === null ||
        current.brandBaseVersionReference === configuration.brandBaseVersionReference,
      // The Store's own time zone governs every business day; a configuration cannot differ.
      TimeZone: configuration.timeZone === input.storeTimeZone,
      // Past business days keep their boundaries: a live Store keeps its business-day start.
      BusinessDayStart:
        current === null ||
        current.businessDayStartLocalTime === configuration.businessDayStartLocalTime,
      Hours: hours,
      // Takes effect now with no end: a future or bounded window would leave the Store without a
      // configuration in force.
      EffectiveDate:
        configuration.effectiveUntil === null &&
        configuration.effectiveFrom <= at &&
        (current === null || configuration.effectiveFrom >= current.effectiveFrom),
      Fees:
        basis !== undefined &&
        basis.feeContexts.every(
          (fee) =>
            fee.state === "Disabled" ||
            fee.orderTypes.every((mode) => configuration.enabledServiceModes.includes(mode)),
        ),
      GoLive: facts.goLive,
      // M109: pickup guests order away from the counter and call the Store about allergies or
      // their order, so a configuration that starts offering pickup needs the Store's published
      // phone. A Store already offering it keeps it (its Home asks for the phone), so its hours
      // and other changes are not held up.
      StorePhone: !storeConfigurationStartsPickup(configuration, current) || facts.storePhone,
    }),
  });
}

export const storeConfigurationPublicationReady = (checks: StoreConfigurationPublicationChecks) =>
  checks.checks.every((check) => check.outcome === "Pass");

export function parseStoreConfigurationPublicationChecks(
  value: unknown,
): StoreConfigurationPublicationChecks {
  const r = readClosedRecord(value, ["profile", "configurationReference", "checkedAt", "checks"]);
  if (
    (r.profile !== "StoreConfigurationPublicationChecksV1" &&
      r.profile !== "StoreConfigurationPublicationChecksV2") ||
    !Array.isArray(r.checks)
  )
    throw new Error("STORE_CONFIGURATION_PUBLICATION_CHECKS_INVALID");
  const profile: ChecksProfile = r.profile;
  const codes = codesOf(profile);
  if (r.checks.length !== codes.length)
    throw new Error("STORE_CONFIGURATION_PUBLICATION_CHECKS_INVALID");
  const checks = r.checks.map((entry: unknown, index: number) => {
    const c = readClosedRecord(entry, ["code", "outcome"]);
    if (c.code !== codes[index] || (c.outcome !== "Pass" && c.outcome !== "Fail"))
      throw new Error("STORE_CONFIGURATION_PUBLICATION_CHECKS_INVALID");
    return Object.freeze({
      code: c.code as StoreConfigurationPublicationCheckCode,
      outcome: c.outcome as "Pass" | "Fail",
    });
  });
  return Object.freeze({
    profile,
    configurationReference: parseStoreAdministrationReference(r.configurationReference),
    checkedAt: parseCanonicalInstant(r.checkedAt),
    checks: Object.freeze(checks),
  });
}
