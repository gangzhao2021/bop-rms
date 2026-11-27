/**
 * WP-2423 item 8 ③ (Owner 2026-10-28 feature decision 16): what a guest is told about the Store's
 * hours beyond "open now" — whether today is a holiday or has special hours, when the kitchen
 * stops taking orders, the holidays and special hours in the next 7 days, and when the Store next
 * opens. Pure; read from the same published weekly hours and dated exceptions the open gate uses
 * (a dated exception replaces that date's weekday hours; no hours means closed all day).
 *
 * Only starts are used for the next opening: an overnight period carried over from yesterday is
 * already open, never "next".
 */
export type StoreUpcomingExceptionKind = "Holiday" | "TemporaryClosure" | "Override";

export interface StoreUpcomingSourceInterval {
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly endsNextDay: boolean;
  /** Seconds before the end of the period that the Store stops taking orders (0: at the end). */
  readonly orderCutoffSeconds: number;
}

export interface StoreUpcomingHoursInput {
  readonly localDate: string;
  readonly localTime: string;
  readonly weeklySchedule: readonly Readonly<{
    isoWeekday: number;
    intervals: readonly StoreUpcomingSourceInterval[];
  }>[];
  readonly exceptions: readonly Readonly<{
    localDate: string;
    kind: StoreUpcomingExceptionKind;
    intervals: readonly StoreUpcomingSourceInterval[];
  }>[];
  /** How many days after today to look ahead (decision 16: 7). */
  readonly days: number;
}

export interface StoreUpcomingInterval {
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly endsNextDay: boolean;
}

export interface StoreUpcomingHours {
  /** Today's dated exception, when today has one. */
  readonly todayKind: StoreUpcomingExceptionKind | null;
  /**
   * The local time ("HH:MM:SS") the current period stops taking orders, when it stops before it
   * ends (a cut-off is set); null otherwise or when the Store is not in a period now.
   */
  readonly lastOrdersAt: string | null;
  /** The same cut-off with its local date (it can fall after midnight). */
  readonly lastOrders: { readonly localDate: string; readonly localTime: string } | null;
  /**
   * WP-2423 item 8 ③ follow-up (v15 2026-10-28): the current period's last orders have passed —
   * guests can't send new orders or rounds until the next period; staff still can.
   */
  readonly pastLastOrders: boolean;
  /** The dated exceptions after today and within `days`, in date order. */
  readonly upcoming: readonly {
    readonly localDate: string;
    readonly kind: StoreUpcomingExceptionKind;
    readonly intervals: readonly StoreUpcomingInterval[];
  }[];
  /** The next start of a period after now, today or within `days`; null when none is published. */
  readonly nextOpening: { readonly localDate: string; readonly startLocalTime: string } | null;
  /**
   * M117: the period the Store is in now, with the local date it began on (yesterday's for an
   * overnight period after midnight); null when the Store is not in a published period now.
   */
  readonly currentPeriod?: {
    readonly startLocalDate: string;
    readonly startLocalTime: string;
    readonly endLocalTime: string;
    readonly endsNextDay: boolean;
  } | null;
}

const DAY = 86_400_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

const seconds = (value: string): number => {
  const [hour = 0, minute = 0, second = 0] = value.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
};

const clock = (total: number): string => {
  const value = ((total % 86_400) + 86_400) % 86_400;
  return [Math.floor(value / 3600), Math.floor((value % 3600) / 60), value % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
};

function shiftDate(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

function isoWeekday(localDate: string): number {
  const day = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

const plain = (intervals: readonly StoreUpcomingSourceInterval[]) =>
  Object.freeze(
    [...intervals]
      .sort((a, b) => seconds(a.startLocalTime) - seconds(b.startLocalTime))
      .map(({ startLocalTime, endLocalTime, endsNextDay }) =>
        Object.freeze({ startLocalTime, endLocalTime, endsNextDay }),
      ),
  );

export function describeStoreUpcomingHours(input: StoreUpcomingHoursInput): StoreUpcomingHours {
  if (!datePattern.test(input.localDate) || !Number.isSafeInteger(input.days) || input.days < 0)
    throw new Error("STORE_UPCOMING_HOURS_INPUT_INVALID");
  const exception = (localDate: string) =>
    input.exceptions.find((entry) => entry.localDate === localDate);
  const intervalsOn = (localDate: string) =>
    exception(localDate)?.intervals ??
    input.weeklySchedule.find((day) => day.isoWeekday === isoWeekday(localDate))?.intervals ??
    [];
  const now = seconds(input.localTime);
  const today = intervalsOn(input.localDate);
  const yesterday = intervalsOn(shiftDate(input.localDate, -1));
  // The period the Store is in now: one of today's, or yesterday's that runs past midnight.
  const fromToday = today.find(
    (interval) =>
      seconds(interval.startLocalTime) <= now &&
      (interval.endsNextDay || now < seconds(interval.endLocalTime)),
  );
  // Batch 36: as in the open gate, today's own dated exception replaces last night's tail too.
  const fromYesterday =
    fromToday === undefined && exception(input.localDate) === undefined
      ? yesterday.find((interval) => interval.endsNextDay && now < seconds(interval.endLocalTime))
      : undefined;
  const current = fromToday ?? fromYesterday;
  // Counted in seconds from the start of the day the period began, so a cut-off after midnight
  // lands on the right date and "now" compares with it across midnight.
  const startDate = fromYesterday === undefined ? input.localDate : shiftDate(input.localDate, -1);
  const cutoff =
    current === undefined || current.orderCutoffSeconds <= 0
      ? null
      : seconds(current.endLocalTime) +
        (current.endsNextDay ? 86_400 : 0) -
        current.orderCutoffSeconds;
  const lastOrdersAt = cutoff === null ? null : clock(cutoff);
  const lastOrders =
    cutoff === null
      ? null
      : Object.freeze({
          localDate: shiftDate(startDate, Math.floor(cutoff / 86_400)),
          localTime: clock(cutoff),
        });
  const pastLastOrders =
    cutoff !== null && now + (fromYesterday === undefined ? 0 : 86_400) >= cutoff;
  const last = shiftDate(input.localDate, input.days);
  const upcoming = Object.freeze(
    input.exceptions
      .filter((entry) => entry.localDate > input.localDate && entry.localDate <= last)
      .sort((a, b) => a.localDate.localeCompare(b.localDate))
      .map((entry) =>
        Object.freeze({
          localDate: entry.localDate,
          kind: entry.kind,
          intervals: plain(entry.intervals),
        }),
      ),
  );
  let nextOpening: StoreUpcomingHours["nextOpening"] = null;
  for (let offset = 0; offset <= input.days && nextOpening === null; offset += 1) {
    const localDate = shiftDate(input.localDate, offset);
    const start = plain(intervalsOn(localDate)).find(
      (interval) => offset > 0 || seconds(interval.startLocalTime) > now,
    );
    if (start !== undefined)
      nextOpening = Object.freeze({ localDate, startLocalTime: start.startLocalTime });
  }
  return Object.freeze({
    todayKind: exception(input.localDate)?.kind ?? null,
    lastOrdersAt,
    lastOrders,
    pastLastOrders,
    upcoming,
    nextOpening,
    currentPeriod:
      current === undefined
        ? null
        : Object.freeze({
            startLocalDate: startDate,
            startLocalTime: current.startLocalTime,
            endLocalTime: current.endLocalTime,
            endsNextDay: current.endsNextDay,
          }),
  });
}

export type StoreBusinessDayClosing =
  /** No hours are published at all: nothing here can say when the Store closes. */
  | { readonly kind: "NoPublishedHours" }
  /** Hours are published and this day has none (a holiday, a closure, a day off). */
  | { readonly kind: "ClosedToday" }
  /**
   * The end of the day's last period, or of the business day when a period is still open then;
   * the local date is the next one when it runs past midnight.
   */
  | {
      readonly kind: "Closes";
      readonly localDate: string;
      readonly localTime: string;
      /**
       * Batch 47 fix-up: a period is still open when the business day ends (open 24 hours, or
       * running past the next day's start), so the closing is only the day's end, not a time the
       * Store closes. False for a Store whose last period ends exactly as the day ends.
       */
      readonly openAtDayEnd: boolean;
    };

/**
 * WP-2423 DEC-CLOSING-SUMMARY: when the Store closes on one business day.
 *
 * Batch 36 (v15 2026-11-20): the business day runs from its start time on the business date to
 * the same time the next date, so its periods are the ones open at some moment inside that span,
 * whatever calendar date they are published on: last night's period still running at the start,
 * the business date's own, and the next date's before the business day ends (00:00-02:00 written
 * on the next date, or a Store open all day). Each ends as the open gate ends it: a period that
 * runs past midnight stops at midnight when the next date has its own dated exception. The
 * closing is the latest end, so the Store's own screens never say it has closed while the open
 * gate still takes orders, and say so once it has stopped. The closing is never after the business
 * day ends: a Store still open then (open 24 hours, or a period running past the start of the next
 * business day) closes this business day at its end.
 */
export function describeStoreBusinessDayClosing(
  input: Pick<StoreUpcomingHoursInput, "weeklySchedule" | "exceptions"> & {
    readonly businessDate: string;
    /** The Store's business-day start ("HH:MM:SS"), from the same publication. */
    readonly businessDayStartLocalTime: string;
  },
): StoreBusinessDayClosing {
  if (
    !datePattern.test(input.businessDate) ||
    !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/u.test(input.businessDayStartLocalTime)
  )
    throw new Error("STORE_UPCOMING_HOURS_INPUT_INVALID");
  const exception = (localDate: string) =>
    input.exceptions.find((entry) => entry.localDate === localDate);
  const anyHours =
    exception(input.businessDate) !== undefined ||
    input.weeklySchedule.some((day) => day.intervals.length > 0);
  if (!anyHours) return Object.freeze({ kind: "NoPublishedHours" });
  const intervalsOn = (localDate: string) =>
    exception(localDate)?.intervals ??
    input.weeklySchedule.find((day) => day.isoWeekday === isoWeekday(localDate))?.intervals ??
    [];
  // Seconds from midnight starting the business date; the day is [dayStart, dayStart + 1 day).
  const dayStart = seconds(input.businessDayStartLocalTime);
  const dayEnd = dayStart + 86_400;
  let end: number | null = null;
  let openAtDayEnd = false;
  for (const offset of [-1, 0, 1]) {
    const localDate = shiftDate(input.businessDate, offset);
    const nextHasException = exception(shiftDate(localDate, 1)) !== undefined;
    for (const interval of intervalsOn(localDate)) {
      const from = offset * 86_400 + seconds(interval.startLocalTime);
      const until =
        offset * 86_400 +
        (interval.endsNextDay
          ? 86_400 + (nextHasException ? 0 : seconds(interval.endLocalTime))
          : seconds(interval.endLocalTime));
      // Batch 47 (v15 b46: Test Merchant 2, open 00:00-23:59:59 every day, read closesAt at the
      // end of the next calendar day, a day after its business day ended): a period still open
      // when the business day ends closes this day at its end; the next day says the rest.
      const closes = Math.min(until, dayEnd);
      if (from < dayEnd && until > dayStart && until > from) {
        if (until > dayEnd) openAtDayEnd = true;
        if (end === null || closes > end) end = closes;
      }
    }
  }
  if (end === null) return Object.freeze({ kind: "ClosedToday" });
  return Object.freeze({
    kind: "Closes",
    localDate: shiftDate(input.businessDate, Math.floor(end / 86_400)),
    localTime: clock(end),
    openAtDayEnd,
  });
}
