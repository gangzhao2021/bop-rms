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
