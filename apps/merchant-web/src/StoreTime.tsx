import { displayLocale, t } from "./i18n/i18n.js";
import { createContext, useContext } from "react";

/** WP-2423: the selected Store's IANA time zone, provided once by the workspace. */
export const StoreTimeZoneContext = createContext<string | undefined>(undefined);

/**
 * An instant as Store-local time: "14:05", or with the date "Oct 14, 2026, 2:05 PM" (never a
 * machine date such as 2026-10-14). UTC, labelled, when the Store's time zone is not known.
 */
export function storeTime(instant: string, timeZone: string | undefined, withDate = false): string {
  if (withDate) {
    const text = new Intl.DateTimeFormat(displayLocale(), {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(instant));
    return timeZone === undefined ? text + " UTC" : text;
  }
  if (timeZone === undefined) return instant.slice(11, 16) + " UTC";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.hour}:${parts.minute}`;
}

/**
 * The Store wall-clock time of an instant as a datetime-local input value ("2026-10-14T14:05").
 * For form inputs only; text staff read uses storeTime.
 */
export function storeLocalInputValue(instant: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * WP-2423 Q21: a Store wall-clock time ("2026-10-13T14:05", as staff read it off a slip or the
 * Store's clock) as the instant it names in the Store's time zone, whatever the device's zone.
 * A time skipped by a spring-forward change resolves to the same wall time after the change; a
 * repeated (fall-back) time resolves to its first occurrence. Null when the text is not a time.
 */
export function storeLocalInstant(localDateTime: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(localDateTime);
  if (match === null) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
  const offset = (at: number) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]),
    );
    return (
      Date.UTC(
        parts.year ?? 0,
        (parts.month ?? 1) - 1,
        parts.day ?? 1,
        parts.hour ?? 0,
        parts.minute ?? 0,
        parts.second ?? 0,
      ) - at
    );
  };
  // Offsets either side of the wall time; the earlier candidate that reads back exactly wins.
  const candidates = [wall - offset(wall - 86_400_000), wall - offset(wall + 86_400_000)]
    .filter((at) => at + offset(at) === wall)
    .sort((a, b) => a - b);
  const at = candidates[0] ?? wall - offset(wall);
  return new Date(at).toISOString();
}

/** A source/record instant as Store-local date and time; the exact UTC instant stays in the title. */
export function SourceTime({
  instant,
  withDate = true,
}: {
  readonly instant: string;
  readonly withDate?: boolean;
}) {
  const timeZone = useContext(StoreTimeZoneContext);
  return (
    <time dateTime={instant} title={instant}>
      {storeTime(instant, timeZone, withDate)}
    </time>
  );
}

/** "Oct 14, 3:00 PM" in the Store's time zone; the year is added when it is not this year. */
export function friendlyStoreTime(
  instant: string,
  timeZone: string | undefined,
  now: Date = new Date(),
): string {
  const zone = timeZone ?? "UTC";
  const year = (at: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric" }).format(at);
  const date = new Date(instant);
  const text = new Intl.DateTimeFormat(displayLocale(), {
    timeZone: zone,
    month: "short",
    day: "numeric",
    ...(year(date) === year(now) ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return timeZone === undefined ? text + " UTC" : text;
}

/**
 * WP-2423: when something ends, as staff say it in the Store's time zone, relative to now:
 * "3:00 PM today", "4:00 AM tomorrow", otherwise "Oct 16, 4:00 AM".
 */
export function storeDayTime(
  instant: string,
  timeZone: string | undefined,
  now: Date = new Date(),
): string {
  const zone = timeZone ?? "UTC";
  const day = (at: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  const date = new Date(instant);
  const today = day(now);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const time = new Intl.DateTimeFormat(displayLocale(), {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const suffix = timeZone === undefined ? " UTC" : "";
  if (day(date) === today) return t("{time}{suffix} today", { time: time, suffix: suffix });
  if (day(date) === tomorrow) return t("{time}{suffix} tomorrow", { time: time, suffix: suffix });
  return friendlyStoreTime(instant, timeZone, now);
}

/**
 * WP-2423: when a screen's information was last read, as staff say it: "Checked 10:11 PM today"
 * (or "Checked Oct 13, 10:11 PM" for an older read), in the Store's time zone. The exact
 * instant stays in the title.
 */
export function CheckedTime({
  instant,
  timeZone,
}: {
  readonly instant: string;
  readonly timeZone?: string | undefined;
}) {
  const contextZone = useContext(StoreTimeZoneContext);
  return (
    <time dateTime={instant} title={instant}>
      {t("Checked {instant}", { instant: storeDayTime(instant, timeZone ?? contextZone) })}
    </time>
  );
}

/** A staff-facing instant such as "Oct 14, 3:00 PM"; the exact instant stays in the title. */
export function StaffTime({ instant }: { readonly instant: string }) {
  const timeZone = useContext(StoreTimeZoneContext);
  return (
    <time dateTime={instant} title={instant}>
      {friendlyStoreTime(instant, timeZone)}
    </time>
  );
}

/**
 * How current a read is: "Updated 14:02" or a visible warning that the data may be out of date.
 * A screen that re-reads on its own passes `checkedAt` (when this device last read it
 * successfully): it then says "Last checked 14:02", so a quiet board whose work has not changed
 * for an hour is not mistaken for a stuck one. The time the work last changed stays in the title.
 */
export function Freshness({
  status,
  at,
  checkedAt,
}: {
  readonly status: "Fresh" | "Stale" | "Current" | "Rebuilding" | "Failed";
  readonly at?: string | undefined;
  readonly checkedAt?: string | undefined;
}) {
  const timeZone = useContext(StoreTimeZoneContext);
  const stale = status !== "Fresh" && status !== "Current";
  if (checkedAt !== undefined)
    return (
      <span
        className="workspace-page__freshness"
        data-freshness={stale ? "Stale" : "Fresh"}
        title={
          at === undefined ? undefined : t("Last change {time}", { time: storeTime(at, timeZone) })
        }
      >
        {stale ? t("Data may be out of date · last checked ") : t("Last checked ")}
        <time dateTime={checkedAt}>{storeTime(checkedAt, timeZone)}</time>
      </span>
    );
  const when = at === undefined ? null : storeTime(at, timeZone);
  return (
    <span className="workspace-page__freshness" data-freshness={stale ? "Stale" : "Fresh"}>
      {stale ? t("Data may be out of date") : t("Updated")}
      {when === null ? "" : ` · ${when}`}
    </span>
  );
}

/**
 * A calendar date as staff read it ("Oct 20, 2026"), never 2026-10-20: an instant is shown on its
 * Store-local day; a plain local date ("2026-10-20", already a Store date) as that day.
 */
export function storeDate(value: string, timeZone: string | undefined): string {
  const plain = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  return new Intl.DateTimeFormat(displayLocale(), {
    timeZone: plain ? "UTC" : (timeZone ?? "UTC"),
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(plain ? value + "T00:00:00.000Z" : value));
}
export function StoreDate({ value }: { readonly value: string }) {
  const timeZone = useContext(StoreTimeZoneContext);
  return (
    <time dateTime={value} title={value}>
      {storeDate(value, timeZone)}
    </time>
  );
}
