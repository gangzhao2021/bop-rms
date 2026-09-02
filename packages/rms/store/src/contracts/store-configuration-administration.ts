import {
  parseBrandReference,
  parseCanonicalInstant,
  parseStoreReference,
  type BrandReference,
  type CanonicalInstant,
  type StoreReference,
} from "@bop/tenant";

export type StoreAdministrationReference = string & {
  readonly __storeAdministrationReference: unique symbol;
};
export type StoreConfigurationVersionNumber = number & {
  readonly __storeConfigurationVersionNumber: unique symbol;
};
export type StoreConfigurationLifecycle =
  "Draft" | "PendingApproval" | "Approved" | "Published" | "Superseded" | "Archived";
export type StoreConfigurationSource = "BrandInherited" | "StoreOverride";
export type StoreAdministrationServiceMode = "DineIn" | "Pickup" | "Delivery";

export class StoreConfigurationAdministrationError extends Error {
  constructor(
    readonly code:
      | "STORE_CONFIGURATION_INPUT_INVALID"
      | "STORE_CONFIGURATION_STATE_INVALID"
      | "STORE_CONFIGURATION_OVERLAP"
      | "STORE_CONFIGURATION_GATE_REQUIRED",
  ) {
    super("Store configuration administration input is invalid");
    this.name = "StoreConfigurationAdministrationError";
  }
}

const fail = (
  code: StoreConfigurationAdministrationError["code"] = "STORE_CONFIGURATION_INPUT_INVALID",
): never => {
  throw new StoreConfigurationAdministrationError(code);
};
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})$/u;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/u;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MODES = ["DineIn", "Pickup", "Delivery"] as const;
const LIFECYCLES = [
  "Draft",
  "PendingApproval",
  "Approved",
  "Published",
  "Superseded",
  "Archived",
] as const;

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    fields.some((field) => {
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    return fail();
  return value as Readonly<Record<string, unknown>>;
}

export function parseStoreAdministrationReference(value: unknown): StoreAdministrationReference {
  return typeof value === "string" && UUID_V7.test(value)
    ? (value as StoreAdministrationReference)
    : fail();
}
const nullableReference = (value: unknown) =>
  value === null ? null : parseStoreAdministrationReference(value);
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): T =>
  typeof value === "string" && choices.includes(value as T) ? (value as T) : fail();
const instant = (value: unknown) => parseCanonicalInstant(value);
const nullableInstant = (value: unknown) => (value === null ? null : instant(value));
function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
}
function code(value: unknown): string {
  return typeof value === "string" && CODE.test(value) ? value : fail();
}
function localTime(value: unknown): string {
  return typeof value === "string" && LOCAL_TIME.test(value) ? value : fail();
}
function localDate(value: unknown): string {
  if (typeof value !== "string") return fail();
  const match = LOCAL_DATE.exec(value);
  if (match === null) return fail();
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) return fail();
  return value;
}
function timeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || value.trim() !== value) return fail();
  try {
    if (new Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions().timeZone !== value)
      return fail();
  } catch {
    return fail();
  }
  return value;
}
function modes(value: unknown, minimum = 1): readonly StoreAdministrationServiceMode[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MODES.length) return fail();
  const result = value.map((mode) => oneOf(mode, MODES));
  if (new Set(result).size !== result.length) return fail();
  return Object.freeze(MODES.filter((mode) => result.includes(mode)));
}
const seconds = (value: string) => {
  const [hour = 0, minute = 0, second = 0] = value.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
};

export interface StoreServiceInterval {
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly endsNextDay: boolean;
  readonly serviceModes: readonly StoreAdministrationServiceMode[];
  readonly orderCutoffSeconds: number;
  readonly leadTimeSeconds: number;
}
function interval(value: unknown): StoreServiceInterval {
  const input = exact(value, [
    "startLocalTime",
    "endLocalTime",
    "endsNextDay",
    "serviceModes",
    "orderCutoffSeconds",
    "leadTimeSeconds",
  ]);
  const start = localTime(input.startLocalTime),
    end = localTime(input.endLocalTime);
  if (
    typeof input.endsNextDay !== "boolean" ||
    typeof input.orderCutoffSeconds !== "number" ||
    !Number.isSafeInteger(input.orderCutoffSeconds) ||
    input.orderCutoffSeconds < 0 ||
    input.orderCutoffSeconds > 86_400 ||
    typeof input.leadTimeSeconds !== "number" ||
    !Number.isSafeInteger(input.leadTimeSeconds) ||
    input.leadTimeSeconds < 0 ||
    input.leadTimeSeconds > 86_400 ||
    (!input.endsNextDay && seconds(end) <= seconds(start)) ||
    (input.endsNextDay && seconds(end) >= seconds(start))
  )
    return fail("STORE_CONFIGURATION_STATE_INVALID");
  return Object.freeze({
    startLocalTime: start,
    endLocalTime: end,
    endsNextDay: input.endsNextDay,
    serviceModes: modes(input.serviceModes),
    orderCutoffSeconds: input.orderCutoffSeconds,
    leadTimeSeconds: input.leadTimeSeconds,
  });
}
function intervals(value: unknown): readonly StoreServiceInterval[] {
  if (!Array.isArray(value) || value.length > 16) return fail();
  const result = value
    .map(interval)
    .toSorted((a, b) => seconds(a.startLocalTime) - seconds(b.startLocalTime));
  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1],
      current = result[index];
    if (previous === undefined || current === undefined) return fail();
    if (previous.endsNextDay || seconds(previous.endLocalTime) > seconds(current.startLocalTime))
      return fail("STORE_CONFIGURATION_OVERLAP");
  }
  return Object.freeze(result);
}

export interface StoreWeeklyServiceDay {
  readonly isoWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly intervals: readonly StoreServiceInterval[];
}
function weeklySchedule(value: unknown): readonly StoreWeeklyServiceDay[] {
  if (!Array.isArray(value) || value.length !== 7) return fail();
  return Object.freeze(
    value.map((entry, index) => {
      const input = exact(entry, ["isoWeekday", "intervals"]);
      if (input.isoWeekday !== index + 1) return fail();
      return Object.freeze({
        isoWeekday: input.isoWeekday as StoreWeeklyServiceDay["isoWeekday"],
        intervals: intervals(input.intervals),
      });
    }),
  );
}

export interface StoreServiceException {
  readonly localDate: string;
  readonly kind: "Holiday" | "TemporaryClosure" | "Override";
  readonly intervals: readonly StoreServiceInterval[];
}
function exceptions(value: unknown): readonly StoreServiceException[] {
  if (!Array.isArray(value) || value.length > 366) return fail();
  const result = value.map((entry) => {
    const input = exact(entry, ["localDate", "kind", "intervals"]);
    return Object.freeze({
      localDate: localDate(input.localDate),
      kind: oneOf(input.kind, ["Holiday", "TemporaryClosure", "Override"] as const),
      intervals: intervals(input.intervals),
    });
  });
  if (new Set(result.map((entry) => entry.localDate)).size !== result.length) return fail();
  return Object.freeze(result.toSorted((a, b) => a.localDate.localeCompare(b.localDate)));
}

export interface StoreConfigurationVersion {
  readonly configurationReference: StoreAdministrationReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly configurationVersion: StoreConfigurationVersionNumber;
  readonly lifecycle: StoreConfigurationLifecycle;
  readonly source: StoreConfigurationSource;
  readonly brandBaseVersionReference: StoreAdministrationReference;
  readonly defaultLocale: string;
  readonly currencyCode: "CAD";
  readonly timeZone: string;
  readonly businessDayStartLocalTime: string;
  readonly addressReference: StoreAdministrationReference;
  readonly contactReference: StoreAdministrationReference;
  readonly receiptReference: StoreAdministrationReference;
  readonly taxConfigurationReference: StoreAdministrationReference;
  readonly paymentConfigurationReference: StoreAdministrationReference;
  readonly capacityConfigurationReference: StoreAdministrationReference | null;
  readonly enabledServiceModes: readonly StoreAdministrationServiceMode[];
  readonly weeklySchedule: readonly StoreWeeklyServiceDay[];
  readonly exceptions: readonly StoreServiceException[];
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
  readonly supersedesConfigurationReference: StoreAdministrationReference | null;
  readonly reasonCode: string;
  readonly authoredByReference: StoreAdministrationReference;
  readonly approvedByReference: StoreAdministrationReference | null;
  readonly approvalEvidenceReference: StoreAdministrationReference | null;
  readonly publicationReference: StoreAdministrationReference | null;
  readonly liveGateEvidenceReference: StoreAdministrationReference | null;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
  readonly dataClassification: "ConfigurationMetadata";
}

export function createStoreConfigurationVersion(value: unknown): StoreConfigurationVersion {
  const fields = [
    "configurationReference",
    "brandReference",
    "storeReference",
    "configurationVersion",
    "lifecycle",
    "source",
    "brandBaseVersionReference",
    "defaultLocale",
    "currencyCode",
    "timeZone",
    "businessDayStartLocalTime",
    "addressReference",
    "contactReference",
    "receiptReference",
    "taxConfigurationReference",
    "paymentConfigurationReference",
    "capacityConfigurationReference",
    "enabledServiceModes",
    "weeklySchedule",
    "exceptions",
    "effectiveFrom",
    "effectiveUntil",
    "supersedesConfigurationReference",
    "reasonCode",
    "authoredByReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "publicationReference",
    "liveGateEvidenceReference",
    "createdAt",
    "updatedAt",
    "dataClassification",
  ] as const;
  const input = exact(value, fields);
  const configurationVersion = positiveInteger(
      input.configurationVersion,
    ) as StoreConfigurationVersionNumber,
    lifecycle = oneOf(input.lifecycle, LIFECYCLES),
    source = oneOf(input.source, ["BrandInherited", "StoreOverride"] as const),
    effectiveFrom = instant(input.effectiveFrom),
    effectiveUntil = nullableInstant(input.effectiveUntil),
    supersedes = nullableReference(input.supersedesConfigurationReference),
    authored = parseStoreAdministrationReference(input.authoredByReference),
    approved = nullableReference(input.approvedByReference),
    approvalEvidence = nullableReference(input.approvalEvidenceReference),
    publication = nullableReference(input.publicationReference),
    liveGate = nullableReference(input.liveGateEvidenceReference),
    createdAt = instant(input.createdAt),
    updatedAt = instant(input.updatedAt);
  const unapproved = lifecycle === "Draft" || lifecycle === "PendingApproval",
    published = lifecycle === "Published" || lifecycle === "Superseded" || lifecycle === "Archived";
  if (
    typeof input.defaultLocale !== "string" ||
    !LOCALE.test(input.defaultLocale) ||
    input.currencyCode !== "CAD" ||
    (configurationVersion === 1) !== (supersedes === null) ||
    (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (approved === null) !== (approvalEvidence === null) ||
    approved === authored ||
    (unapproved && (approved !== null || publication !== null || liveGate !== null)) ||
    (lifecycle === "Approved" &&
      (approved === null || publication !== null || liveGate !== null)) ||
    (published && (approved === null || publication === null || liveGate === null))
  )
    return fail("STORE_CONFIGURATION_STATE_INVALID");
  return Object.freeze({
    configurationReference: parseStoreAdministrationReference(input.configurationReference),
    brandReference: parseBrandReference(input.brandReference),
    storeReference: parseStoreReference(input.storeReference),
    configurationVersion,
    lifecycle,
    source,
    brandBaseVersionReference: parseStoreAdministrationReference(input.brandBaseVersionReference),
    defaultLocale: input.defaultLocale,
    currencyCode: "CAD",
    timeZone: timeZone(input.timeZone),
    businessDayStartLocalTime: localTime(input.businessDayStartLocalTime),
    addressReference: parseStoreAdministrationReference(input.addressReference),
    contactReference: parseStoreAdministrationReference(input.contactReference),
    receiptReference: parseStoreAdministrationReference(input.receiptReference),
    taxConfigurationReference: parseStoreAdministrationReference(input.taxConfigurationReference),
    paymentConfigurationReference: parseStoreAdministrationReference(
      input.paymentConfigurationReference,
    ),
    capacityConfigurationReference: nullableReference(input.capacityConfigurationReference),
    enabledServiceModes: modes(input.enabledServiceModes),
    weeklySchedule: weeklySchedule(input.weeklySchedule),
    exceptions: exceptions(input.exceptions),
    effectiveFrom,
    effectiveUntil,
    supersedesConfigurationReference: supersedes,
    reasonCode: code(input.reasonCode),
    authoredByReference: authored,
    approvedByReference: approved,
    approvalEvidenceReference: approvalEvidence,
    publicationReference: publication,
    liveGateEvidenceReference: liveGate,
    createdAt,
    updatedAt,
    dataClassification:
      input.dataClassification === "ConfigurationMetadata" ? "ConfigurationMetadata" : fail(),
  });
}

export function validateStoreConfigurationForPublication(
  configuration: StoreConfigurationVersion,
): void {
  if (
    configuration.lifecycle !== "Published" ||
    configuration.approvalEvidenceReference === null ||
    configuration.publicationReference === null ||
    configuration.liveGateEvidenceReference === null ||
    configuration.enabledServiceModes.length === 0 ||
    !configuration.weeklySchedule.some((day) => day.intervals.length > 0)
  )
    fail("STORE_CONFIGURATION_GATE_REQUIRED");
  for (const day of configuration.weeklySchedule)
    for (const entry of day.intervals)
      if (entry.serviceModes.some((mode) => !configuration.enabledServiceModes.includes(mode)))
        fail("STORE_CONFIGURATION_STATE_INVALID");
}
