import { createContext, useContext } from "react";

/** WP-2423: the selected Store's IANA time zone, provided once by the workspace. */
export const StoreTimeZoneContext = createContext<string | undefined>(undefined);

/** An instant as Store-local time (UTC when the Store's time zone is not known). */
export function storeTime(instant: string, timeZone: string | undefined, withDate = false): string {
  if (timeZone === undefined)
    return (withDate ? instant.slice(0, 10) + " " : "") + instant.slice(11, 16) + " UTC";
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
  const time = `${parts.hour}:${parts.minute}`;
  return withDate ? `${parts.year}-${parts.month}-${parts.day} ${time}` : time;
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
  if (timeZone === undefined) return <time dateTime={instant}>{instant}</time>;
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
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    ...(year(date) === year(now) ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return timeZone === undefined ? text + " UTC" : text;
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

/** How current a read is: "Updated 14:02" or a visible warning that the data may be out of date. */
export function Freshness({
  status,
  at,
}: {
  readonly status: "Fresh" | "Stale" | "Current" | "Rebuilding" | "Failed";
  readonly at?: string | undefined;
}) {
  const timeZone = useContext(StoreTimeZoneContext);
  const stale = status !== "Fresh" && status !== "Current";
  const when = at === undefined ? null : storeTime(at, timeZone);
  return (
    <span className="workspace-page__freshness" data-freshness={stale ? "Stale" : "Fresh"}>
      {stale ? "Data may be out of date" : "Updated"}
      {when === null ? "" : ` · ${when}`}
    </span>
  );
}
