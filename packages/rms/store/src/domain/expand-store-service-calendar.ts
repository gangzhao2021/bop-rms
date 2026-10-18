import { parseCanonicalInstant, type CanonicalInstant } from "@bop/tenant";
import { resolveStoreLocalInstant } from "./resolve-business-date.js";

/**
 * WP-2423 (DEC-PICKUP-CAPACITY-SCHEDULE): a Store's published hours for one service, laid out as
 * UTC instants over a future window, plus the business days that window touches. Pure; the
 * Store owns its hours, time zone and business-day start, so other domains (Fulfillment's pickup
 * capacity schedule) consume this expansion instead of re-reading Store facts.
 *
 * The rule is the one evaluateStoreOperatingStatus applies at an instant, before any pause: a
 * dated exception replaces that date's weekday hours (no hours = closed all day), an interval
 * that ends the next day carries into the following date unless that date has its own exception,
 * and every local time is resolved in the Store's IANA zone across daylight-saving changes.
 * Pauses are not applied: they are short, staff end them early, and the open gate already reads
 * them at the moment of ordering.
 */
export type StoreCalendarServiceMode = "DineIn" | "Pickup" | "Delivery";

export interface StoreCalendarInterval {
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly endsNextDay: boolean;
  readonly serviceModes: readonly string[];
}

export interface StoreServiceCalendarInput {
  readonly timeZone: string;
  readonly businessDayStartLocalTime: string;
  readonly weeklySchedule: readonly Readonly<{
    isoWeekday: number;
    intervals: readonly StoreCalendarInterval[];
  }>[];
  readonly exceptions: readonly Readonly<{
    localDate: string;
    intervals: readonly StoreCalendarInterval[];
  }>[];
  readonly serviceMode: StoreCalendarServiceMode;
  readonly from: string;
  readonly until: string;
}

export interface StoreServiceWindow {
  readonly startsAt: CanonicalInstant;
  readonly endsAt: CanonicalInstant;
}

export interface StoreServiceBusinessDay {
  readonly businessDate: string;
  readonly startsAt: CanonicalInstant;
  readonly endsAt: CanonicalInstant;
}

export interface StoreServiceCalendar {
  readonly timeZone: string;
  readonly from: CanonicalInstant;
  readonly until: CanonicalInstant;
  /** Merged, ordered and clipped to [from, until). */
  readonly windows: readonly StoreServiceWindow[];
  /** Every business day overlapping [from, until), in order and contiguous. */
  readonly businessDays: readonly StoreServiceBusinessDay[];
}

export class StoreServiceCalendarError extends Error {
  readonly code = "STORE_SERVICE_CALENDAR_INPUT_INVALID";
  constructor() {
    super("store service calendar input is invalid");
    this.name = "StoreServiceCalendarError";
  }
}

const DAY = 86_400_000;
/** A schedule is read at most this far ahead (the Store publishes at most 366 exceptions). */
const MAXIMUM_SPAN = 62 * DAY;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u;

function fail(): never {
  throw new StoreServiceCalendarError();
}

function shiftDate(localDate: string, days: number): string {
  const value = new Date(Date.parse(`${localDate}T00:00:00.000Z`) + days * DAY);
  return value.toISOString().slice(0, 10);
}

function isoWeekday(localDate: string): number {
  const day = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function localDateOf(instant: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function at(timeZone: string, localDate: string, localTime: string): number {
  if (!timePattern.test(localTime)) return fail();
  return Date.parse(resolveStoreLocalInstant({ timeZone, localDate, localTime }).instant);
}

function iso(value: number): CanonicalInstant {
  return parseCanonicalInstant(new Date(value).toISOString());
}

export function expandStoreServiceCalendar(input: StoreServiceCalendarInput): StoreServiceCalendar {
  let from: number, until: number;
  try {
    from = Date.parse(parseCanonicalInstant(input.from));
    until = Date.parse(parseCanonicalInstant(input.until));
    new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone }).format(new Date(0));
  } catch {
    return fail();
  }
  if (
    until <= from ||
    until - from > MAXIMUM_SPAN ||
    !["DineIn", "Pickup", "Delivery"].includes(input.serviceMode) ||
    typeof input.businessDayStartLocalTime !== "string" ||
    !timePattern.test(input.businessDayStartLocalTime) ||
    !Array.isArray(input.weeklySchedule) ||
    !Array.isArray(input.exceptions)
  )
    return fail();
  const { timeZone } = input;
  const weekly = new Map<number, readonly StoreCalendarInterval[]>();
  for (const day of input.weeklySchedule) {
    if (!Number.isInteger(day.isoWeekday) || day.isoWeekday < 1 || day.isoWeekday > 7) fail();
    if (weekly.has(day.isoWeekday)) fail();
    weekly.set(day.isoWeekday, day.intervals);
  }
  if (weekly.size !== 7) fail();
  const exceptions = new Map<string, readonly StoreCalendarInterval[]>();
  for (const exception of input.exceptions) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(exception.localDate) || exceptions.has(exception.localDate))
      fail();
    exceptions.set(exception.localDate, exception.intervals);
  }
  const intervalsOf = (localDate: string) =>
    exceptions.get(localDate) ?? weekly.get(isoWeekday(localDate)) ?? fail();

  // One local day either side covers overnight intervals and zones far from UTC.
  const firstDate = shiftDate(localDateOf(from, timeZone), -1);
  const lastDate = shiftDate(localDateOf(until, timeZone), 1);
  const raw: [number, number][] = [];
  for (let date = firstDate; date <= lastDate; date = shiftDate(date, 1)) {
    for (const interval of intervalsOf(date)) {
      if (!interval.serviceModes.includes(input.serviceMode)) continue;
      const start = at(timeZone, date, interval.startLocalTime);
      const endDate = interval.endsNextDay ? shiftDate(date, 1) : date;
      let end = at(timeZone, endDate, interval.endLocalTime);
      // The next date's own exception replaces this interval's carried-over tail.
      if (interval.endsNextDay && exceptions.has(endDate))
        end = Math.min(end, at(timeZone, endDate, "00:00:00"));
      if (end > start) raw.push([start, end]);
    }
  }
  raw.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of raw) {
    const clippedStart = Math.max(start, from),
      clippedEnd = Math.min(end, until);
    if (clippedEnd <= clippedStart) continue;
    const last = merged[merged.length - 1];
    if (last !== undefined && clippedStart <= last[1]) last[1] = Math.max(last[1], clippedEnd);
    else merged.push([clippedStart, clippedEnd]);
  }

  const businessDays: StoreServiceBusinessDay[] = [];
  for (let date = firstDate; date <= lastDate; date = shiftDate(date, 1)) {
    const startsAt = at(timeZone, date, input.businessDayStartLocalTime);
    const endsAt = at(timeZone, shiftDate(date, 1), input.businessDayStartLocalTime);
    if (endsAt <= startsAt) return fail();
    if (endsAt <= from || startsAt >= until) continue;
    businessDays.push(
      Object.freeze({ businessDate: date, startsAt: iso(startsAt), endsAt: iso(endsAt) }),
    );
  }
  const firstDay = businessDays[0],
    lastDay = businessDays[businessDays.length - 1];
  if (
    firstDay === undefined ||
    lastDay === undefined ||
    Date.parse(firstDay.startsAt) > from ||
    Date.parse(lastDay.endsAt) < until
  )
    return fail();
  return Object.freeze({
    timeZone,
    from: iso(from),
    until: iso(until),
    windows: Object.freeze(
      merged.map(([start, end]) => Object.freeze({ startsAt: iso(start), endsAt: iso(end) })),
    ),
    businessDays: Object.freeze(businessDays),
  });
}
