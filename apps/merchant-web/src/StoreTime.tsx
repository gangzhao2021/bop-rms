import { displayLocale, t } from "./i18n/i18n.js";
import { createContext, useContext } from "react";

/** WP-2423: the selected Store's IANA time zone, provided once by the workspace. */
export const StoreTimeZoneContext = createContext<string | undefined>(undefined);
/**
 * Batch 63 (F24): Home's header stamp is when "Right now" was last read; the section reports it
 * here instead of carrying a second "Last checked" of its own.
 */
export const PageReadAtContext = createContext<((at: string) => void) | null>(null);

/**
 * Batch 42 (v15 chase at 10:04:10 refused, "chase it again at 10:04"): the first whole minute at
 * or after an instant. A "you can … again at {time}" shown to the minute must never be before the
 * instant it stands for, so a time with seconds is rounded up, never down.
 */
export function wholeMinuteAtOrAfter(instant: string): string {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return instant;
  return new Date(Math.ceil(ms / 60_000) * 60_000).toISOString();
}

/**
 * Batch 64 (v15 b63: staff screens wrote one moment three ways — "Updated 12:32 p.m." on Hours,
 * "12:15 p.m." on Tables beside "12:15" on Orders, "Nov 25, 2026, 12:28 PM by You" under Paid):
 * every time on a staff screen is the Store's 24-hour clock, "14:05" in English and Chinese alike.
 * With the date, the weekday and date come first, the year only when it is not this year — "Sat,
 * Oct 24 20:00" / "10月24日周六 20:00", as Orders writes an earlier day.
 * UTC, labelled, when the Store's time zone is not known. Guests' pages keep their own style.
 */
export function storeTime(instant: string, timeZone: string | undefined, withDate = false): string {
  return withDate ? friendlyStoreTime(instant, timeZone) : clockOf(instant, timeZone);
}

/** "14:05" on the Store's clock ("14:05 UTC" when its zone is not known). */
function clockOf(instant: string, timeZone: string | undefined): string {
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

/** "2026-10-14": the Store's calendar day of an instant. */
function dayOf(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
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

/**
 * An instant with its day, as staff read it (batch 64): "Wed, Oct 14 15:00" ("10月14日周三
 * 15:00"), with the year only when it is not this year. Always the 24-hour clock.
 */
export function friendlyStoreTime(
  instant: string,
  timeZone: string | undefined,
  now: Date = new Date(),
): string {
  const zone = timeZone ?? "UTC";
  const date = new Date(instant);
  const label = new Intl.DateTimeFormat(displayLocale(), {
    timeZone: zone,
    ...(dayOf(date, zone).slice(0, 4) === dayOf(now, zone).slice(0, 4) ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(date);
  return `${label} ${clockOf(instant, timeZone)}`;
}

/**
 * When something happened, as a line of a record says it (batch 64, v15 M177 "22:42 by Mei"):
 * today's time alone, another day's with its day ("Wed, Oct 14 15:00").
 */
export function storeWhen(
  instant: string,
  timeZone: string | undefined,
  now: Date = new Date(),
): string {
  const zone = timeZone ?? "UTC";
  return dayOf(new Date(instant), zone) === dayOf(now, zone)
    ? clockOf(instant, timeZone)
    : friendlyStoreTime(instant, timeZone, now);
}

/**
 * WP-2423: when something ends, as staff say it in the Store's time zone, relative to now:
 * "15:00 today", "04:00 tomorrow", otherwise "Fri, Oct 16 04:00".
 */
export function storeDayTime(
  instant: string,
  timeZone: string | undefined,
  now: Date = new Date(),
): string {
  const zone = timeZone ?? "UTC";
  const day = (at: Date) => dayOf(at, zone);
  const date = new Date(instant);
  const today = day(now);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const time = clockOf(instant, zone);
  const suffix = timeZone === undefined ? " UTC" : "";
  if (day(date) === today) return t("{time}{suffix} today", { time: time, suffix: suffix });
  if (day(date) === tomorrow) return t("{time}{suffix} tomorrow", { time: time, suffix: suffix });
  return friendlyStoreTime(instant, timeZone, now);
}

/**
 * WP-2423: when a screen's information was last read, as staff say it: "Checked 22:11 today"
 * (or "Checked Tue, Oct 13 22:11" for an older read), in the Store's time zone. The exact
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

/**
 * A staff-facing instant such as "Wed, Oct 14 15:00"; the exact instant stays in the title.
 */
export function StaffTime({ instant }: { readonly instant: string }) {
  const timeZone = useContext(StoreTimeZoneContext);
  return (
    <time dateTime={instant} title={instant}>
      {friendlyStoreTime(instant, timeZone)}
    </time>
  );
}

/**
 * How current a read is: "Updated 14:02" ("已更新 14:02"), the one stamp every back-office page
 * shows (batch 63, F24: Orders said "01:36 已更新", Exceptions "已更新 · 01:36", Home only
 * "已更新"), or a visible warning that the data may be out of date. A screen that re-reads on its
 * own passes `checkedAt` (when this device last read it successfully), so a quiet board whose
 * work has not changed for an hour still shows when it was last read; the time the work last
 * changed stays in the title.
 */
export function Freshness({
  status,
  at,
  checkedAt,
  timeZone: readZone,
}: {
  readonly status: "Fresh" | "Stale" | "Current" | "Rebuilding" | "Failed";
  readonly at?: string | undefined;
  readonly checkedAt?: string | undefined;
  /** Batch 65: the Store's zone as the read itself names it (Item availability does). */
  readonly timeZone?: string | undefined;
}) {
  // Batch 64: before the Store's zone is known, this device's clock, which on a store tablet is
  // the Store's; never "14:02 UTC" in the one stamp of a page.
  const contextZone = useContext(StoreTimeZoneContext);
  const timeZone = readZone ?? contextZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stale = status !== "Fresh" && status !== "Current";
  const read = checkedAt ?? at;
  const when = read === undefined ? null : storeTime(read, timeZone);
  return (
    <span
      className="workspace-page__freshness"
      data-freshness={stale ? "Stale" : "Fresh"}
      title={
        checkedAt === undefined || at === undefined
          ? undefined
          : t("Last change {time}", { time: storeTime(at, timeZone) })
      }
    >
      {when === null ? (
        stale ? (
          t("Data may be out of date")
        ) : (
          t("Updated")
        )
      ) : stale ? (
        <time dateTime={read}>
          {t("Data may be out of date · last checked {time}", { time: when })}
        </time>
      ) : (
        <time dateTime={read}>{t("Updated {time}", { time: when })}</time>
      )}
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

/**
 * Orders v2: when an order was placed, in one style — the time today, else the date with the
 * weekday ("Sat, Oct 24 20:00"), with the year only when it is not this year.
 */
export function orderWhen(instant: string, timeZone: string | undefined, today: string | null) {
  const time = storeTime(instant, timeZone);
  if (timeZone === undefined) return time;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
  if (date === today) return time;
  const label = new Intl.DateTimeFormat(displayLocale(), {
    timeZone,
    ...(today !== null && date.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(new Date(instant));
  return `${label} ${time}`;
}
/**
 * Batch 67 (v15 b65 live, zh 390): a date and time said at the end of a line ("11月27日周五 01:32",
 * "Fri, Nov 27 01:32") wrap as one piece: no-break spaces, and a word joiner beside each Chinese
 * character, where a line may otherwise break. It reads and is read aloud as before.
 */
export function unbrokenWhen(text: string): string {
  return text
    .replace(/ /gu, "\u00a0")
    .replace(/(?<=\p{Script=Han})(?=\S)|(?<=\S)(?=\p{Script=Han})/gu, "\u2060");
}
