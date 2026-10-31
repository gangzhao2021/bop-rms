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
  const fromYesterday =
    fromToday === undefined
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
  });
}
