import {
  parseBrandReference,
  parseCanonicalInstant,
  parseStoreReference,
  type BrandReference,
  type CanonicalInstant,
  type StoreReference,
} from "@bop/tenant";

export type StoreBusinessDate = string & { readonly __storeBusinessDate: unique symbol };
export type BusinessDayStartLocalTime = string & {
  readonly __businessDayStartLocalTime: unique symbol;
};
export type BusinessDateConfigurationReference = string & {
  readonly __businessDateConfigurationReference: unique symbol;
};
export type BusinessDateContentDigest = string & {
  readonly __businessDateContentDigest: unique symbol;
};

export const defaultBusinessDayStartLocalTime = "04:00:00" as BusinessDayStartLocalTime;

export interface StoreBusinessDateConfiguration {
  readonly configurationReference: BusinessDateConfigurationReference;
  readonly configurationVersion: number;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly timeZone: string;
  readonly businessDayStartLocalTime: BusinessDayStartLocalTime;
  readonly businessDayStartSource: "PlatformDefault" | "StoreOverride";
  readonly contentDigest: BusinessDateContentDigest;
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
}

export interface ResolveStoreBusinessDateInput {
  readonly occurredAt: unknown;
  readonly configuration: unknown;
}

export interface StoreBusinessDateResolution {
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly occurredAt: CanonicalInstant;
  readonly businessDate: StoreBusinessDate;
  readonly businessDateBoundaryAt: CanonicalInstant;
  readonly boundaryDisambiguation: "Exact" | "GapForward" | "OverlapEarlier";
  readonly configurationReference: BusinessDateConfigurationReference;
  readonly configurationVersion: number;
  readonly contentDigest: BusinessDateContentDigest;
  readonly timeZone: string;
  readonly businessDayStartLocalTime: BusinessDayStartLocalTime;
}

export const businessDateErrorCodes = [
  "STORE_BUSINESS_DATE_INPUT_INVALID",
  "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE",
] as const;
export type BusinessDateErrorCode = (typeof businessDateErrorCodes)[number];

export class BusinessDateError extends Error {
  readonly code: BusinessDateErrorCode;

  constructor(code: BusinessDateErrorCode) {
    super("store business date resolution failed");
    this.name = "BusinessDateError";
    this.code = code;
  }
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const localTime = /^(?:[01]\d|2[0-3]):[0-5]\d:00$/u;

function fail(): never {
  throw new BusinessDateError("STORE_BUSINESS_DATE_INPUT_INVALID");
}

function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
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

function reference<T extends string>(value: unknown): T {
  if (typeof value !== "string" || !uuidV7.test(value)) return fail();
  return value as T;
}

function instant(value: unknown): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return fail();
  }
}

export function parseStoreBusinessDateConfiguration(
  value: unknown,
): StoreBusinessDateConfiguration {
  const raw = closed(value, [
    "configurationReference",
    "configurationVersion",
    "brandReference",
    "storeReference",
    "timeZone",
    "businessDayStartLocalTime",
    "businessDayStartSource",
    "contentDigest",
    "effectiveFrom",
    "effectiveUntil",
  ]);
  if (
    !Number.isSafeInteger(raw.configurationVersion) ||
    (raw.configurationVersion as number) < 1 ||
    typeof raw.timeZone !== "string" ||
    typeof raw.businessDayStartLocalTime !== "string" ||
    !localTime.test(raw.businessDayStartLocalTime) ||
    !["PlatformDefault", "StoreOverride"].includes(String(raw.businessDayStartSource)) ||
    typeof raw.contentDigest !== "string" ||
    !digest.test(raw.contentDigest)
  )
    return fail();
  if (
    raw.businessDayStartSource === "PlatformDefault" &&
    raw.businessDayStartLocalTime !== defaultBusinessDayStartLocalTime
  )
    return fail();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: raw.timeZone }).format(new Date(0));
    const effectiveFrom = instant(raw.effectiveFrom);
    const effectiveUntil = raw.effectiveUntil === null ? null : instant(raw.effectiveUntil);
    if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom))
      return fail();
    return Object.freeze({
      configurationReference: reference<BusinessDateConfigurationReference>(
        raw.configurationReference,
      ),
      configurationVersion: raw.configurationVersion as number,
      brandReference: parseBrandReference(raw.brandReference),
      storeReference: parseStoreReference(raw.storeReference),
      timeZone: raw.timeZone,
      businessDayStartLocalTime: raw.businessDayStartLocalTime as BusinessDayStartLocalTime,
      businessDayStartSource: raw.businessDayStartSource as "PlatformDefault" | "StoreOverride",
      contentDigest: raw.contentDigest as BusinessDateContentDigest,
      effectiveFrom,
      effectiveUntil,
    });
  } catch {
    return fail();
  }
}

export function parseBusinessDateInstant(value: unknown): CanonicalInstant {
  return instant(value);
}

interface LocalFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fields(format: Intl.DateTimeFormat, epochMilliseconds: number): LocalFields {
  const values = Object.fromEntries(
    format
      .formatToParts(new Date(epochMilliseconds))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

function dateText(value: LocalFields): StoreBusinessDate {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(
    value.day,
  ).padStart(2, "0")}` as StoreBusinessDate;
}

function previousDate(value: LocalFields): LocalFields {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day - 1));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function tuple(value: LocalFields): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
}

function boundaryInstant(
  format: Intl.DateTimeFormat,
  date: LocalFields,
  start: string,
): Readonly<{ epochMilliseconds: number; kind: "Exact" | "GapForward" | "OverlapEarlier" }> {
  const [hour, minute] = start.split(":").map(Number) as [number, number];
  const target: LocalFields = { ...date, hour, minute, second: 0 };
  const targetTuple = tuple(target);
  const candidates = new Set<number>();
  for (let offsetHour = -36; offsetHour <= 36; offsetHour += 3) {
    const sample = targetTuple + offsetHour * 3_600_000;
    const sampleOffset = tuple(fields(format, sample)) - sample;
    const candidate = targetTuple - sampleOffset;
    if (tuple(fields(format, candidate)) === targetTuple) candidates.add(candidate);
  }
  const exact = [...candidates].sort((left, right) => left - right);
  if (exact.length > 0)
    return Object.freeze({
      epochMilliseconds: exact[0] as number,
      kind: exact.length > 1 ? "OverlapEarlier" : "Exact",
    });

  for (let delta = -18 * 60; delta <= 18 * 60; delta += 1) {
    const candidate = targetTuple + delta * 60_000;
    const local = fields(format, candidate);
    if (
      local.year === target.year &&
      local.month === target.month &&
      local.day === target.day &&
      tuple(local) > targetTuple
    )
      return Object.freeze({ epochMilliseconds: candidate, kind: "GapForward" });
  }
  throw new BusinessDateError("STORE_BUSINESS_DATE_INPUT_INVALID");
}

export function resolveStoreBusinessDate(
  input: ResolveStoreBusinessDateInput,
): StoreBusinessDateResolution {
  const occurredAt = parseBusinessDateInstant(input.occurredAt);
  const configuration = parseStoreBusinessDateConfiguration(input.configuration);
  const occurredEpoch = Date.parse(occurredAt);
  if (
    occurredEpoch < Date.parse(configuration.effectiveFrom) ||
    (configuration.effectiveUntil !== null &&
      occurredEpoch >= Date.parse(configuration.effectiveUntil))
  )
    throw new BusinessDateError("STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE");

  const format = formatter(configuration.timeZone);
  const local = fields(format, occurredEpoch);
  let businessDateFields = local;
  let boundary = boundaryInstant(
    format,
    businessDateFields,
    configuration.businessDayStartLocalTime,
  );
  if (occurredEpoch < boundary.epochMilliseconds) {
    businessDateFields = previousDate(local);
    boundary = boundaryInstant(format, businessDateFields, configuration.businessDayStartLocalTime);
  }

  return Object.freeze({
    brandReference: configuration.brandReference,
    storeReference: configuration.storeReference,
    occurredAt,
    businessDate: dateText(businessDateFields),
    businessDateBoundaryAt: new Date(boundary.epochMilliseconds).toISOString() as CanonicalInstant,
    boundaryDisambiguation: boundary.kind,
    configurationReference: configuration.configurationReference,
    configurationVersion: configuration.configurationVersion,
    contentDigest: configuration.contentDigest,
    timeZone: configuration.timeZone,
    businessDayStartLocalTime: configuration.businessDayStartLocalTime,
  });
}

/** The Store business day an instant falls in: its date and both local boundaries. */
export interface StoreBusinessDay {
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly observedAt: CanonicalInstant;
  readonly businessDate: StoreBusinessDate;
  /** The day's start (inclusive) and end (exclusive), each at the business-day start time. */
  readonly startsAt: CanonicalInstant;
  readonly endsAt: CanonicalInstant;
  readonly timeZone: string;
  readonly businessDayStartLocalTime: BusinessDayStartLocalTime;
  readonly configurationReference: BusinessDateConfigurationReference;
  readonly configurationVersion: number;
  readonly contentDigest: BusinessDateContentDigest;
}

/**
 * WP-2423 Q21: the one definition of "today" for a Store — the business day the instant falls in,
 * from the Store's published IANA time zone and business-day start (not the calendar day), with
 * both boundaries resolved across daylight-saving changes (a day may last 23 or 25 hours). The end
 * is placed by the configuration in force at observedAt; a later version taking effect within the
 * day is read when that day is closed (resolveClosedStoreBusinessDateWindowAcross).
 */
export function resolveStoreBusinessDay(input: ResolveStoreBusinessDateInput): StoreBusinessDay {
  const resolution = resolveStoreBusinessDate(input);
  const configuration = parseStoreBusinessDateConfiguration(input.configuration);
  const { start, end } = closedBounds(configuration, resolution.businessDate);
  if (
    start.epochMilliseconds !== Date.parse(resolution.businessDateBoundaryAt) ||
    end.epochMilliseconds <= Date.parse(resolution.occurredAt)
  )
    return fail();
  return Object.freeze({
    brandReference: resolution.brandReference,
    storeReference: resolution.storeReference,
    observedAt: resolution.occurredAt,
    businessDate: resolution.businessDate,
    startsAt: resolution.businessDateBoundaryAt,
    endsAt: new Date(end.epochMilliseconds).toISOString() as CanonicalInstant,
    timeZone: resolution.timeZone,
    businessDayStartLocalTime: resolution.businessDayStartLocalTime,
    configurationReference: resolution.configurationReference,
    configurationVersion: resolution.configurationVersion,
    contentDigest: resolution.contentDigest,
  });
}

export interface ClosedStoreBusinessDateWindow {
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly businessDate: StoreBusinessDate;
  readonly startsAt: CanonicalInstant;
  readonly endsAt: CanonicalInstant;
  readonly startDisambiguation: StoreBusinessDateResolution["boundaryDisambiguation"];
  readonly endDisambiguation: StoreBusinessDateResolution["boundaryDisambiguation"];
  readonly configurationReference: BusinessDateConfigurationReference;
  readonly configurationVersion: number;
  readonly contentDigest: BusinessDateContentDigest;
  readonly timeZone: string;
  readonly businessDayStartLocalTime: BusinessDayStartLocalTime;
}

function closedBounds(configuration: StoreBusinessDateConfiguration, businessDate: unknown) {
  if (typeof businessDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) return fail();
  const date = new Date(`${businessDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== businessDate)
    return fail();
  const next = new Date(date.getTime() + 86_400_000);
  const localDate = (value: Date): LocalFields => ({
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  });
  const format = formatter(configuration.timeZone);
  const start = boundaryInstant(format, localDate(date), configuration.businessDayStartLocalTime);
  const end = boundaryInstant(format, localDate(next), configuration.businessDayStartLocalTime);
  if (start.epochMilliseconds >= end.epochMilliseconds) return fail();
  return { businessDate: businessDate as StoreBusinessDate, start, end };
}

/** Local boundaries of one Store business date under a configuration's time zone and
 * day start, independent of its effective period. Used only to enumerate the
 * configurations governing that day; the closed window still needs full coverage. */
export function resolveStoreBusinessDateBounds(input: {
  readonly businessDate: unknown;
  readonly configuration: unknown;
}): { readonly startsAt: CanonicalInstant; readonly endsAt: CanonicalInstant } {
  const bounds = closedBounds(
    parseStoreBusinessDateConfiguration(input.configuration),
    input.businessDate,
  );
  return Object.freeze({
    startsAt: new Date(bounds.start.epochMilliseconds).toISOString() as CanonicalInstant,
    endsAt: new Date(bounds.end.epochMilliseconds).toISOString() as CanonicalInstant,
  });
}

/** Resolve both local boundaries, including DST, under one effective configuration.
 * A configuration transition inside the requested day requires separate evidence. */
export function resolveClosedStoreBusinessDateWindow(input: {
  readonly businessDate: unknown;
  readonly observedAt: unknown;
  readonly configuration: unknown;
}): ClosedStoreBusinessDateWindow {
  const configuration = parseStoreBusinessDateConfiguration(input.configuration);
  const observedAt = parseBusinessDateInstant(input.observedAt);
  const { start, end } = closedBounds(configuration, input.businessDate);
  if (end.epochMilliseconds > Date.parse(observedAt)) return fail();
  if (
    start.epochMilliseconds < Date.parse(configuration.effectiveFrom) ||
    (configuration.effectiveUntil !== null &&
      end.epochMilliseconds > Date.parse(configuration.effectiveUntil))
  )
    throw new BusinessDateError("STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE");
  return Object.freeze({
    brandReference: configuration.brandReference,
    storeReference: configuration.storeReference,
    businessDate: input.businessDate as StoreBusinessDate,
    startsAt: new Date(start.epochMilliseconds).toISOString() as CanonicalInstant,
    endsAt: new Date(end.epochMilliseconds).toISOString() as CanonicalInstant,
    startDisambiguation: start.kind,
    endDisambiguation: end.kind,
    configurationReference: configuration.configurationReference,
    configurationVersion: configuration.configurationVersion,
    contentDigest: configuration.contentDigest,
    timeZone: configuration.timeZone,
    businessDayStartLocalTime: configuration.businessDayStartLocalTime,
  });
}

/** Closed business day governed by the consecutive configurations in force across it
 * (each in force at a successive instant from the day's start; the last at its end).
 * Several versions may govern one day only when every one places the boundaries
 * identically: same time zone, business-day start and start source. Otherwise the day
 * is refused (STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE), never merged. The
 * result carries the identity of the configuration in force at the day's end, so a
 * day under one configuration resolves exactly as resolveClosedStoreBusinessDateWindow.
 */
export function resolveClosedStoreBusinessDateWindowAcross(input: {
  readonly businessDate: unknown;
  readonly observedAt: unknown;
  readonly configurations: readonly unknown[];
}): ClosedStoreBusinessDateWindow {
  if (
    !Array.isArray(input.configurations) ||
    input.configurations.length < 1 ||
    input.configurations.length > 64
  )
    return fail();
  const configurations = input.configurations.map(parseStoreBusinessDateConfiguration);
  const first = configurations[0];
  const last = configurations[configurations.length - 1];
  if (!first || !last) return fail();
  for (const configuration of configurations) {
    if (
      configuration.brandReference !== last.brandReference ||
      configuration.storeReference !== last.storeReference
    )
      return fail();
    if (
      configuration.timeZone !== last.timeZone ||
      configuration.businessDayStartLocalTime !== last.businessDayStartLocalTime ||
      configuration.businessDayStartSource !== last.businessDayStartSource
    )
      throw new BusinessDateError("STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE");
  }
  // The chain covers the day from the first version's start to the last version's end.
  return resolveClosedStoreBusinessDateWindow({
    businessDate: input.businessDate,
    observedAt: input.observedAt,
    configuration: { ...last, effectiveFrom: first.effectiveFrom },
  });
}
