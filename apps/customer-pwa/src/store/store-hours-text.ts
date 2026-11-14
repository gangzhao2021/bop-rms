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

/** "11:00 a.m.–3:00 p.m." or "Closed" for one day's published periods. */
export function intervalsText(intervals: readonly StoreLocalInterval[]): string {
  if (intervals.length === 0) return t("Closed");
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
