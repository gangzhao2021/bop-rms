import type { EffectiveConfigurationVersion } from "@bop/effective-period";
import type { PublishingLifecycleRecord, PublishingReleaseRecord } from "@bop/publishing";
import {
  parseBrandReference,
  parseCanonicalInstant,
  parseStoreReference,
  type BrandReference,
  type CanonicalInstant,
  type OrganizationLifecycle,
  type StoreReference,
} from "@bop/tenant";
import type { PublicStoreReference } from "./public-store-profile.js";

export type StoreOperatingConfigurationReference = string & {
  readonly __storeOperatingConfigurationReference: unique symbol;
};
export type StoreOperatingEvidenceReference = string & {
  readonly __storeOperatingEvidenceReference: unique symbol;
};
export type StoreOperatingClosureReference = string & {
  readonly __storeOperatingClosureReference: unique symbol;
};
export type StoreOperatingContentDigest = string & {
  readonly __storeOperatingContentDigest: unique symbol;
};
export type StoreOperatingConfigurationVersion = number & {
  readonly __storeOperatingConfigurationVersion: unique symbol;
};
export type StoreLocalDate = string & { readonly __storeLocalDate: unique symbol };
export type StoreLocalTime = string & { readonly __storeLocalTime: unique symbol };

export const storeServiceModes = ["DineIn", "Pickup", "Delivery"] as const;
export type StoreServiceMode = (typeof storeServiceModes)[number];
export type StoreOperatingState = "Open" | "Closed" | "TemporarilyClosed";

export interface GetStoreOperatingStatusRequest {
  readonly publicStoreReference: PublicStoreReference;
  readonly evaluatedAt: CanonicalInstant;
  readonly purpose: "CustomerEntry";
}

export interface StoreOperatingStatusResolutionEvidence {
  readonly publicStoreReference: PublicStoreReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly brandLifecycle: OrganizationLifecycle;
  readonly storeLifecycle: OrganizationLifecycle;
  readonly lookupEvidenceReference: StoreOperatingEvidenceReference;
  readonly validUntil: CanonicalInstant;
}

export interface StoreOperatingInterval {
  readonly startLocalTime: StoreLocalTime;
  readonly endLocalTime: StoreLocalTime;
  readonly endsNextDay: boolean;
  readonly serviceModes: readonly StoreServiceMode[];
}

export interface StoreWeeklyOperatingDay {
  readonly isoWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly intervals: readonly StoreOperatingInterval[];
}

export interface StoreOperatingException {
  readonly localDate: StoreLocalDate;
  readonly intervals: readonly StoreOperatingInterval[];
}

export interface StoreTemporaryClosure {
  readonly closureReference: StoreOperatingClosureReference;
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant;
  readonly serviceModes: readonly StoreServiceMode[] | null;
}

export interface StoreOperatingConfigurationCandidate {
  readonly configurationReference: StoreOperatingConfigurationReference;
  readonly configurationVersion: StoreOperatingConfigurationVersion;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly classification: "Public";
  readonly timeZone: string;
  readonly weeklySchedule: readonly StoreWeeklyOperatingDay[];
  readonly exceptions: readonly StoreOperatingException[];
  readonly temporaryClosures: readonly StoreTemporaryClosure[];
  readonly contentDigest: StoreOperatingContentDigest;
  readonly publishingLifecycle: PublishingLifecycleRecord;
  readonly publishingRelease: PublishingReleaseRecord;
  readonly effectiveVersion: EffectiveConfigurationVersion;
}

export interface StoreOperatingStatus {
  readonly configurationReference: StoreOperatingConfigurationReference;
  readonly configurationVersion: StoreOperatingConfigurationVersion;
  readonly releaseReference: string;
  readonly contentDigest: StoreOperatingContentDigest;
  readonly evaluatedAt: CanonicalInstant;
  readonly timeZone: string;
  readonly localDate: StoreLocalDate;
  readonly localTime: StoreLocalTime;
  readonly state: StoreOperatingState;
  readonly availableServiceModes: readonly StoreServiceMode[];
}

export type GetStoreOperatingStatusResult =
  | Readonly<{ status: "Available"; operatingStatus: StoreOperatingStatus }>
  | Readonly<{ status: "InvalidRequest" }>
  | Readonly<{ status: "StoreUnavailable" }>;

export const storeOperatingContractErrorCodes = [
  "STORE_OPERATING_REQUEST_INVALID",
  "STORE_OPERATING_EVIDENCE_INVALID",
  "STORE_OPERATING_CONFIGURATION_INVALID",
] as const;
export type StoreOperatingContractErrorCode = (typeof storeOperatingContractErrorCodes)[number];

export class StoreOperatingContractError extends Error {
  readonly code: StoreOperatingContractErrorCode;

  constructor(code: StoreOperatingContractErrorCode) {
    super("store operating status contract is invalid");
    this.name = "StoreOperatingContractError";
    this.code = code;
  }
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const localDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const localTimePattern = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/u;

function fail(code: StoreOperatingContractErrorCode): never {
  throw new StoreOperatingContractError(code);
}

function readExactRecord(
  value: unknown,
  fields: readonly string[],
  code: StoreOperatingContractErrorCode,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail(code);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    return fail(code);
  return value as Readonly<Record<string, unknown>>;
}

function readExactArray(
  value: unknown,
  minimum: number,
  maximum: number,
  code: StoreOperatingContractErrorCode,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  )
    return fail(code);
  const indexes = Array.from({ length: value.length }, (_, index) => String(index));
  const expectedKeys = new Set([...indexes, "length"]);
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) ||
    indexes.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    return fail(code);
  return value;
}

function parseUuid<T extends string>(value: unknown, code: StoreOperatingContractErrorCode): T {
  if (typeof value !== "string" || !uuidV7.test(value)) return fail(code);
  return value as T;
}

function parseInstant(value: unknown, code: StoreOperatingContractErrorCode): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return fail(code);
  }
}

function parseLocalDate(value: unknown, code: StoreOperatingContractErrorCode): StoreLocalDate {
  if (typeof value !== "string") return fail(code);
  const match = localDatePattern.exec(value);
  if (match === null) return fail(code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return fail(code);
  return value as StoreLocalDate;
}

function parseLocalTime(value: unknown, code: StoreOperatingContractErrorCode): StoreLocalTime {
  if (typeof value !== "string" || !localTimePattern.test(value)) return fail(code);
  return value as StoreLocalTime;
}

function timeSeconds(value: StoreLocalTime): number {
  const [hour = 0, minute = 0, second = 0] = value.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
}

function parseTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || value.trim() !== value)
    return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  try {
    if (new Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions().timeZone !== value)
      return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  } catch {
    return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  }
  return value;
}

function parseServiceModes(value: unknown, minimum: 0 | 1): readonly StoreServiceMode[] {
  const input = readExactArray(
    value,
    minimum,
    storeServiceModes.length,
    "STORE_OPERATING_CONFIGURATION_INVALID",
  );
  const modes = input.map((mode) => {
    if (typeof mode !== "string" || !storeServiceModes.includes(mode as StoreServiceMode))
      return fail("STORE_OPERATING_CONFIGURATION_INVALID");
    return mode as StoreServiceMode;
  });
  if (
    new Set(modes).size !== modes.length ||
    modes.some((mode, index) => {
      const previous = modes[index - 1];
      return (
        previous !== undefined &&
        storeServiceModes.indexOf(previous) >= storeServiceModes.indexOf(mode)
      );
    })
  )
    return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  return Object.freeze(modes);
}

function parseInterval(value: unknown): StoreOperatingInterval {
  const input = readExactRecord(
    value,
    ["startLocalTime", "endLocalTime", "endsNextDay", "serviceModes"],
    "STORE_OPERATING_CONFIGURATION_INVALID",
  );
  if (typeof input.endsNextDay !== "boolean") return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  const startLocalTime = parseLocalTime(
    input.startLocalTime,
    "STORE_OPERATING_CONFIGURATION_INVALID",
  );
  const endLocalTime = parseLocalTime(input.endLocalTime, "STORE_OPERATING_CONFIGURATION_INVALID");
  const start = timeSeconds(startLocalTime);
  const end = timeSeconds(endLocalTime);
  if ((!input.endsNextDay && start >= end) || (input.endsNextDay && start < end))
    return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  return Object.freeze({
    startLocalTime,
    endLocalTime,
    endsNextDay: input.endsNextDay,
    serviceModes: parseServiceModes(input.serviceModes, 1),
  });
}

function intervalEnd(interval: StoreOperatingInterval): number {
  return timeSeconds(interval.endLocalTime) + (interval.endsNextDay ? 86_400 : 0);
}

function parseIntervals(value: unknown): readonly StoreOperatingInterval[] {
  const input = readExactArray(value, 0, 24, "STORE_OPERATING_CONFIGURATION_INVALID");
  const intervals = input.map(parseInterval);
  for (let index = 0; index < intervals.length; index += 1) {
    const current = intervals[index];
    if (current === undefined) return fail("STORE_OPERATING_CONFIGURATION_INVALID");
    if (index > 0) {
      const previous = intervals[index - 1];
      if (previous === undefined || timeSeconds(current.startLocalTime) < intervalEnd(previous))
        return fail("STORE_OPERATING_CONFIGURATION_INVALID");
    }
  }
  return Object.freeze(intervals);
}

function hasSegmentOverlap(segments: readonly Readonly<{ start: number; end: number }>[]): boolean {
  const sorted = [...segments]
    .filter((item) => item.start < item.end)
    .sort((left, right) => {
      return left.start - right.start || left.end - right.end;
    });
  return sorted.some((segment, index) => {
    const previous = sorted[index - 1];
    return previous !== undefined && segment.start < previous.end;
  });
}

function validateWeeklyCrossDayOverlap(weeklySchedule: readonly StoreWeeklyOperatingDay[]): void {
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const current = weeklySchedule[dayIndex];
    const previous = weeklySchedule[(dayIndex + 6) % 7];
    if (current === undefined || previous === undefined)
      return fail("STORE_OPERATING_CONFIGURATION_INVALID");
    const segments = [
      ...current.intervals.map((interval) => ({
        start: timeSeconds(interval.startLocalTime),
        end: interval.endsNextDay ? 86_400 : timeSeconds(interval.endLocalTime),
      })),
      ...previous.intervals
        .filter((interval) => interval.endsNextDay)
        .map((interval) => ({ start: 0, end: timeSeconds(interval.endLocalTime) })),
    ];
    if (hasSegmentOverlap(segments)) return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  }
}

function parseWeeklySchedule(value: unknown): readonly StoreWeeklyOperatingDay[] {
  const input = readExactArray(value, 7, 7, "STORE_OPERATING_CONFIGURATION_INVALID");
  const schedule = input.map((item, index) => {
    const day = readExactRecord(
      item,
      ["isoWeekday", "intervals"],
      "STORE_OPERATING_CONFIGURATION_INVALID",
    );
    if (day.isoWeekday !== index + 1) return fail("STORE_OPERATING_CONFIGURATION_INVALID");
    return Object.freeze({
      isoWeekday: day.isoWeekday as StoreWeeklyOperatingDay["isoWeekday"],
      intervals: parseIntervals(day.intervals),
    });
  });
  validateWeeklyCrossDayOverlap(schedule);
  return Object.freeze(schedule);
}

function parseExceptions(value: unknown): readonly StoreOperatingException[] {
  const input = readExactArray(value, 0, 366, "STORE_OPERATING_CONFIGURATION_INVALID");
  const exceptions = input.map((item) => {
    const exception = readExactRecord(
      item,
      ["localDate", "intervals"],
      "STORE_OPERATING_CONFIGURATION_INVALID",
    );
    return Object.freeze({
      localDate: parseLocalDate(exception.localDate, "STORE_OPERATING_CONFIGURATION_INVALID"),
      intervals: parseIntervals(exception.intervals),
    });
  });
  if (
    exceptions.some(
      (exception, index) =>
        index > 0 && exception.localDate <= (exceptions[index - 1]?.localDate ?? ""),
    )
  )
    return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  return Object.freeze(exceptions);
}

function nextLocalDate(localDate: StoreLocalDate): StoreLocalDate {
  const [year = 0, month = 0, day = 0] = localDate.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + 1));
  return [
    String(value.getUTCFullYear()).padStart(4, "0"),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-") as StoreLocalDate;
}

function isoWeekdayForDate(localDate: StoreLocalDate): number {
  const [year = 0, month = 0, day = 0] = localDate.split("-").map(Number);
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

function validateExceptionCrossDayOverlap(
  weeklySchedule: readonly StoreWeeklyOperatingDay[],
  exceptions: readonly StoreOperatingException[],
): void {
  const exceptionDates = new Set(exceptions.map((exception) => exception.localDate));
  for (const exception of exceptions) {
    const nextDate = nextLocalDate(exception.localDate);
    if (exceptionDates.has(nextDate)) continue;
    const nextWeeklyDay = weeklySchedule[isoWeekdayForDate(nextDate) - 1];
    if (nextWeeklyDay === undefined) return fail("STORE_OPERATING_CONFIGURATION_INVALID");
    const segments = [
      ...exception.intervals
        .filter((interval) => interval.endsNextDay)
        .map((interval) => ({ start: 0, end: timeSeconds(interval.endLocalTime) })),
      ...nextWeeklyDay.intervals.map((interval) => ({
        start: timeSeconds(interval.startLocalTime),
        end: interval.endsNextDay ? 86_400 : timeSeconds(interval.endLocalTime),
      })),
    ];
    if (hasSegmentOverlap(segments)) return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  }
}

function parseTemporaryClosures(value: unknown): readonly StoreTemporaryClosure[] {
  const input = readExactArray(value, 0, 100, "STORE_OPERATING_CONFIGURATION_INVALID");
  const closures = input.map((item) => {
    const closure = readExactRecord(
      item,
      ["closureReference", "effectiveFrom", "effectiveUntil", "serviceModes"],
      "STORE_OPERATING_CONFIGURATION_INVALID",
    );
    const effectiveFrom = parseInstant(
      closure.effectiveFrom,
      "STORE_OPERATING_CONFIGURATION_INVALID",
    );
    const effectiveUntil = parseInstant(
      closure.effectiveUntil,
      "STORE_OPERATING_CONFIGURATION_INVALID",
    );
    if (Date.parse(effectiveFrom) >= Date.parse(effectiveUntil))
      return fail("STORE_OPERATING_CONFIGURATION_INVALID");
    return Object.freeze({
      closureReference: parseUuid<StoreOperatingClosureReference>(
        closure.closureReference,
        "STORE_OPERATING_CONFIGURATION_INVALID",
      ),
      effectiveFrom,
      effectiveUntil,
      serviceModes:
        closure.serviceModes === null ? null : parseServiceModes(closure.serviceModes, 1),
    });
  });
  if (
    new Set(closures.map((closure) => closure.closureReference)).size !== closures.length ||
    closures.some((closure, index) => {
      const previous = closures[index - 1];
      return (
        previous !== undefined &&
        (closure.effectiveFrom < previous.effectiveFrom ||
          (closure.effectiveFrom === previous.effectiveFrom &&
            closure.closureReference <= previous.closureReference))
      );
    })
  )
    return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  return Object.freeze(closures);
}

export function parseGetStoreOperatingStatusRequest(
  value: unknown,
): GetStoreOperatingStatusRequest {
  const input = readExactRecord(
    value,
    ["publicStoreReference", "evaluatedAt", "purpose"],
    "STORE_OPERATING_REQUEST_INVALID",
  );
  if (input.purpose !== "CustomerEntry") return fail("STORE_OPERATING_REQUEST_INVALID");
  return Object.freeze({
    publicStoreReference: parseUuid<PublicStoreReference>(
      input.publicStoreReference,
      "STORE_OPERATING_REQUEST_INVALID",
    ),
    evaluatedAt: parseInstant(input.evaluatedAt, "STORE_OPERATING_REQUEST_INVALID"),
    purpose: "CustomerEntry",
  });
}

export function parseStoreOperatingStatusResolutionEvidence(
  value: unknown,
): StoreOperatingStatusResolutionEvidence {
  const input = readExactRecord(
    value,
    [
      "publicStoreReference",
      "brandReference",
      "storeReference",
      "brandLifecycle",
      "storeLifecycle",
      "lookupEvidenceReference",
      "validUntil",
    ],
    "STORE_OPERATING_EVIDENCE_INVALID",
  );
  if (
    !["Draft", "Active", "Suspended", "Archived"].includes(input.brandLifecycle as string) ||
    !["Draft", "Active", "Suspended", "Archived"].includes(input.storeLifecycle as string)
  )
    return fail("STORE_OPERATING_EVIDENCE_INVALID");
  try {
    return Object.freeze({
      publicStoreReference: parseUuid<PublicStoreReference>(
        input.publicStoreReference,
        "STORE_OPERATING_EVIDENCE_INVALID",
      ),
      brandReference: parseBrandReference(input.brandReference),
      storeReference: parseStoreReference(input.storeReference),
      brandLifecycle: input.brandLifecycle as OrganizationLifecycle,
      storeLifecycle: input.storeLifecycle as OrganizationLifecycle,
      lookupEvidenceReference: parseUuid<StoreOperatingEvidenceReference>(
        input.lookupEvidenceReference,
        "STORE_OPERATING_EVIDENCE_INVALID",
      ),
      validUntil: parseInstant(input.validUntil, "STORE_OPERATING_EVIDENCE_INVALID"),
    });
  } catch {
    return fail("STORE_OPERATING_EVIDENCE_INVALID");
  }
}

export function parseStoreOperatingConfigurationCandidateShape(
  value: unknown,
): StoreOperatingConfigurationCandidate {
  const input = readExactRecord(
    value,
    [
      "configurationReference",
      "configurationVersion",
      "brandReference",
      "storeReference",
      "classification",
      "timeZone",
      "weeklySchedule",
      "exceptions",
      "temporaryClosures",
      "contentDigest",
      "publishingLifecycle",
      "publishingRelease",
      "effectiveVersion",
    ],
    "STORE_OPERATING_CONFIGURATION_INVALID",
  );
  if (
    input.classification !== "Public" ||
    !Number.isSafeInteger(input.configurationVersion) ||
    (input.configurationVersion as number) < 1 ||
    typeof input.contentDigest !== "string" ||
    !digest.test(input.contentDigest)
  )
    return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  let brandReference: BrandReference;
  let storeReference: StoreReference;
  try {
    brandReference = parseBrandReference(input.brandReference);
    storeReference = parseStoreReference(input.storeReference);
  } catch {
    return fail("STORE_OPERATING_CONFIGURATION_INVALID");
  }
  const weeklySchedule = parseWeeklySchedule(input.weeklySchedule);
  const exceptions = parseExceptions(input.exceptions);
  validateExceptionCrossDayOverlap(weeklySchedule, exceptions);
  return Object.freeze({
    configurationReference: parseUuid<StoreOperatingConfigurationReference>(
      input.configurationReference,
      "STORE_OPERATING_CONFIGURATION_INVALID",
    ),
    configurationVersion: input.configurationVersion as StoreOperatingConfigurationVersion,
    brandReference,
    storeReference,
    classification: "Public",
    timeZone: parseTimeZone(input.timeZone),
    weeklySchedule,
    exceptions,
    temporaryClosures: parseTemporaryClosures(input.temporaryClosures),
    contentDigest: input.contentDigest as StoreOperatingContentDigest,
    publishingLifecycle: input.publishingLifecycle as PublishingLifecycleRecord,
    publishingRelease: input.publishingRelease as PublishingReleaseRecord,
    effectiveVersion: input.effectiveVersion as EffectiveConfigurationVersion,
  });
}
