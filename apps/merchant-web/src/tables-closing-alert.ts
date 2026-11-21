import { clockTime, clockTimeEndingSentence, countOf, t } from "./i18n/i18n.js";

/**
 * b39 (v15 b38 dinner sweep; AGENTS.md "warn before timeouts"): nothing closes a table by itself at
 * the end of the business day, so a table nobody closed stays open into the next days (owner-hotpot
 * had eight from two weeks before). Servers are told on Tables, the screen they work in: from an
 * hour before the Store closes, after it closes, and in the last hour of the business day when no
 * closing time is published, how many of today's tables are still open and what to do.
 */
export const tablesClosingLeadMinutes = 60;

export function tablesClosingAlert(
  day: {
    readonly endsAt: string | null;
    readonly closesAt?: string | null;
  } | null,
  now: number,
  /** Today's tables still seated (not those left from earlier days, which are listed apart). */
  openTables: number,
  timeZone?: string,
): { readonly tone: "soon" | "past"; readonly text: string } | null {
  if (day === null || openTables === 0) return null;
  // b40: the guests' style of time ("10:00 p.m."); one that ends a sentence brings its period.
  const time = (at: number) => clockTime(at, timeZone);
  const timeAtEnd = (at: number) => clockTimeEndingSentence(at, timeZone);
  const lead = tablesClosingLeadMinutes * 60_000;
  const ends = day.endsAt === null ? Number.NaN : Date.parse(day.endsAt);
  const closes =
    day.closesAt === undefined || day.closesAt === null ? Number.NaN : Date.parse(day.closesAt);
  const tables = countOf(openTables, "table");
  if (Number.isFinite(closes) && now >= closes - lead && now < closes)
    return {
      tone: "soon",
      text: t(
        "Closing at {time}: {tables} still open. Take each table's payment and close it when the guests leave.",
        { time: time(closes), tables },
      ),
    };
  if (Number.isFinite(closes) && now >= closes && (!Number.isFinite(ends) || now < ends))
    return {
      tone: "past",
      text: Number.isFinite(ends)
        ? t(
            "Closed at {time}: {tables} still open. Take the payment, or record that the guests left without paying, and close each table before the day ends at {end}.",
            { time: time(closes), tables, end: timeAtEnd(ends) },
          )
        : t(
            "Closed at {time}: {tables} still open. Take the payment, or record that the guests left without paying, and close each table.",
            { time: time(closes), tables },
          ),
    };
  if (!Number.isFinite(closes) && Number.isFinite(ends) && now >= ends - lead && now < ends)
    return {
      tone: "past",
      text: t(
        "The business day ends at {end}: {tables} still open. Take the payment, or record that the guests left without paying, and close each table.",
        { end: time(ends), tables },
      ),
    };
  return null;
}
