import { dateLocale, listSeparator, t } from "../i18n/i18n.js";
import { formatStoreLocalTime } from "../journey/format.js";

/**
 * WP-2423 item 8 ③ (Owner decision 16): the Store's hours ahead in the guest's words — a holiday
 * or special hours, when the Store opens next — for the scan page when the Store is closed and the
 * store section at the bottom of the menu. Dates are the Store's own local dates (no time zone
 * conversion), named "today" and "tomorrow" when they are.
 */
export type StoreDayKind = "Holiday" | "TemporaryClosure" | "Override";

export interface StoreLocalInterval {
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly endsNextDay: boolean;
}

const DAY = 86_400_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

/** "Saturday, Dec 26" (中文 "12月26日 周六") for a Store-local date. */
function calendarDate(localDate: string, locale = dateLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${localDate}T00:00:00.000Z`));
}

/** "today", "tomorrow" or "Saturday, Dec 26", relative to the Store's own date. */
export function storeDayName(localDate: string, today: string | null): string {
  if (!datePattern.test(localDate)) return "";
  if (today !== null && datePattern.test(today)) {
    const days = Math.round((Date.parse(localDate) - Date.parse(today)) / DAY);
    if (days === 0) return t("today");
    if (days === 1) return t("tomorrow");
  }
  return calendarDate(localDate);
}

/** "Opens tomorrow at 11:00 a.m." (or "opens …" inside a line). */
export function nextOpeningText(
  next: { readonly localDate: string; readonly startLocalTime: string },
  today: string | null,
  within: "Sentence" | "Line" = "Sentence",
): string {
  const values = {
    day: storeDayName(next.localDate, today),
    time: formatStoreLocalTime(next.startLocalTime),
  };
  return within === "Sentence"
    ? t("Opens {day} at {time}", values)
    : t("opens {day} at {time}", values);
}

const secondsOf = (value: string): number => {
  const [hour = 0, minute = 0, second = 0] = value.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
};

/**
 * Batch 46 (v15 overnight 45): the day's periods leave no gap from midnight to midnight — one
 * period 00:00–23:59:59 (the only way the hours model writes a whole day: a period can't end at
 * the same time it starts), 00:00–23:59, or periods back to back. Such a Store is open 24 hours,
 * never "until 11:59 p.m.". A minute's gap is allowed, as the hours are written in minutes.
 */
export function isOpenAllDay(intervals: readonly StoreLocalInterval[]): boolean {
  const sorted = [...intervals].sort(
    (a, b) => secondsOf(a.startLocalTime) - secondsOf(b.startLocalTime),
  );
  if (sorted.length === 0 || secondsOf(sorted[0]?.startLocalTime ?? "") > 0) return false;
  let reached = 0;
  for (const interval of sorted) {
    if (secondsOf(interval.startLocalTime) > reached + 60) return false;
    const end = interval.endsNextDay ? 86_400 : secondsOf(interval.endLocalTime);
    reached = Math.max(reached, end);
  }
  return reached >= 86_400 - 60;
}

/**
 * Batch 46: after the kitchen's last orders on a day open 24 hours, the Store doesn't close: the
 * period ends at the end of the day and the next one starts at midnight.
 */
export function opensAgainAtMidnight(
  closesAt: string,
  next: { readonly localDate: string; readonly startLocalTime: string },
  today: string | null,
): boolean {
  if (today === null || !datePattern.test(today) || !datePattern.test(next.localDate)) return false;
  return (
    secondsOf(closesAt) >= 86_400 - 60 &&
    Math.round((Date.parse(next.localDate) - Date.parse(today)) / DAY) === 1 &&
    secondsOf(next.startLocalTime) < 60
  );
}

/** "11:00 a.m.–3:00 p.m.", "open 24 hours" or "Closed" for one day's published periods. */
export function intervalsText(intervals: readonly StoreLocalInterval[]): string {
  if (intervals.length === 0) return t("Closed");
  if (isOpenAllDay(intervals)) return t("open 24 hours");
  return intervals
    .map(
      (interval) =>
        `${formatStoreLocalTime(interval.startLocalTime)}–${formatStoreLocalTime(interval.endLocalTime)}${
          interval.endsNextDay ? t(" (next day)") : ""
        }`,
    )
    .join(listSeparator());
}

/** "Holiday", "Closed" or "Special hours" — what the Store set for a date. */
export function dayKindLabel(kind: StoreDayKind, intervals: readonly StoreLocalInterval[]): string {
  if (intervals.length === 0) return kind === "Holiday" ? t("Holiday · closed") : t("Closed");
  return kind === "Holiday" ? t("Holiday hours") : t("Special hours");
}
