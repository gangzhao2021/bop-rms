import { PaidOrderWatchContext } from "./PaidOrderAlarm.js";
import { paidOrderAlarmMinutes, paidOrdersStuck } from "./paid-order-watch.js";
import { useEffect, useMemo, useState, useContext } from "react";
import { Link } from "react-router";
import { countOf, t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { openedOnEarlierDay } from "./earlier-day-tables.js";
import { useStoreBusinessDay } from "./StoreBusinessDay.js";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { createStoreReportsClient, type TonightSummary } from "./store-reports-client.js";

/** The reports screen (Owner, Store Manager): only they see the closing reminder. */
export const closingReminderScreen = "RPT-OPS-DASHBOARD";
/**
 * The fallback when the Store's hours can't be read or none are published: the last 8 hours of the
 * business day (from 20:00 with the usual 04:00 cut-off).
 */
export const closingReminderHours = 8;
/** DEC-CLOSING-SUMMARY: from an hour before the Store closes, while tables can still pay. */
export const closingReminderLeadMinutes = 60;
/** ...and for an hour after, while staff close up. Later, only an unpaid table is worth saying. */
export const closingReminderAfterMinutes = 60;
const rereadMs = 5 * 60_000;

export function inClosingWindow(endsAt: string | null, now: number): boolean {
  if (endsAt === null) return false;
  const left = Date.parse(endsAt) - now;
  return left > 0 && left <= closingReminderHours * 3_600_000;
}

export type ClosingReminderPhase =
  /** Not yet. */
  | "Hidden"
  /** The fallback window, or the hour before the Store closes. */
  | "BeforeClosing"
  /** The hour after the Store closes. */
  | "AfterClosing"
  /** Later that business day, or a day the Store is closed: shown only for an unpaid table. */
  | "UnpaidTablesOnly";

export function closingReminderPhase(
  day: {
    readonly endsAt: string | null;
    readonly closesAt?: string | null;
    readonly closedToday?: boolean;
  } | null,
  now: number,
): ClosingReminderPhase {
  if (day === null) return "Hidden";
  if (day.closedToday === true) return "UnpaidTablesOnly";
  if (day.closesAt === undefined || day.closesAt === null)
    return inClosingWindow(day.endsAt, now) ? "BeforeClosing" : "Hidden";
  const closes = Date.parse(day.closesAt);
  if (now < closes - closingReminderLeadMinutes * 60_000) return "Hidden";
  if (now < closes) return "BeforeClosing";
  return now < closes + closingReminderAfterMinutes * 60_000 ? "AfterClosing" : "UnpaidTablesOnly";
}

/**
 * Batch 35 review: whether the reminder shows for these screens at this moment and so has figures
 * to read. Home works this out from the same day it holds for, rather than from a report the
 * reminder makes after rendering, which lagged a render behind a late day read.
 */
export function closingReminderShows(
  screens: readonly string[],
  day: Parameters<typeof closingReminderPhase>[0],
  now: number,
): boolean {
  return screens.includes(closingReminderScreen) && closingReminderPhase(day, now) !== "Hidden";
}

/**
 * WP-2423 item 8 ② (Figma 47-2, home snippet): on Home, around the Store's closing, tell the Owner
 * or Store Manager what is still open — tables not paid yet and today's net taken — with one step:
 * see today's summary. Read once when shown and every 5 minutes while it shows.
 */
export function ClosingReminder({
  screens,
  fetcher,
  onFiguresRead,
}: {
  readonly screens: readonly string[];
  readonly fetcher?: typeof fetch | undefined;
  /**
   * Batch 35: told once tonight's figures have been read (or the read failed), so Home, which
   * knows from the day whether the reminder shows (closingReminderShows), shows it with its other
   * sections instead of the reminder appearing a moment after them. Until then it renders nothing.
   */
  readonly onFiguresRead?: (() => void) | undefined;
}) {
  const day = useStoreBusinessDay();
  const live = useStaffSessionLive();
  const watch = useContext(PaidOrderWatchContext);
  const client = useMemo(() => createStoreReportsClient(fetcher), [fetcher]);
  const [now, setNow] = useState(() => Date.now());
  const [summary, setSummary] = useState<TonightSummary | null>(null);
  const [answered, setAnswered] = useState(false);
  const allowed = screens.includes(closingReminderScreen);
  const phase = allowed ? closingReminderPhase(day, now) : "Hidden";
  const show = phase !== "Hidden";
  useEffect(() => {
    if (!allowed || !live) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [allowed, live]);
  useEffect(() => {
    if (!show || !live) return;
    let controller = new AbortController();
    const read = () => {
      controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      client
        .tonight(signal)
        .then((value) => {
          if (!signal.aborted) {
            setSummary(value);
            setAnswered(true);
          }
        })
        .catch(() => {
          /* The reminder keeps its last figures; the summary page says when it can't read. */
          if (!signal.aborted) setAnswered(true);
        });
    };
    read();
    const timer = setInterval(read, rereadMs);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [show, live, client]);
  const settled = !show || !live || answered;
  useEffect(() => {
    if (answered) onFiguresRead?.();
  }, [onFiguresRead, answered]);
  // Shown once, with its figures: a reminder that appears after Home has shown (the day's hours
  // read late) moves what is below it once, not again when its figures arrive.
  if (!show || !settled) return null;
  const stuck = paidOrdersStuck(watch, now);
  const cantMake = watch?.cantMakeRefunds ?? 0;
  // b39: tables left open from earlier days are not tonight's to collect (Tables and the summary
  // list them apart). b39-2 (review): the reminder still names them, so the manager closing the
  // day is not told every table is paid while an earlier day's table is open.
  const fromEarlierDay = (table: TonightSummary["openTables"][number]) =>
    summary !== null &&
    openedOnEarlierDay(
      table.openedMinutes,
      Date.parse(summary.report.generatedAt),
      Date.parse(summary.report.startsAt),
    );
  const open =
    summary?.openTables.filter((table) => table.owedMinor !== "0" && !fromEarlierDay(table)) ?? [];
  const earlier = summary?.openTables.filter(fromEarlierDay) ?? [];
  const earlierOwedMinor = earlier.reduce((sum, table) => sum + BigInt(table.owedMinor), 0n);
  // b40 (b39 review): later in the night only an unpaid table is worth saying, and a table left
  // open from an earlier day that still owes is one, so it is named even when today's are paid.
  if (phase === "UnpaidTablesOnly" && open.length === 0 && earlierOwedMinor === 0n) return null;
  const before = phase === "BeforeClosing";
  const net =
    summary === null
      ? ""
      : orderMoney({
          amountMinor: summary.report.summary.netCollectedMinor,
          currencyCode: "CAD",
        });
  const owed = {
    tables: countOf(open.length, "table"),
    amount:
      summary === null
        ? ""
        : orderMoney({
            amountMinor: open.reduce((sum, table) => sum + BigInt(table.owedMinor), 0n).toString(),
            currencyCode: "CAD",
          }),
  };
  return (
    <section
      className="closing-reminder"
      aria-label={before ? t("Before closing") : t("After closing")}
    >
      <div>
        <p className="closing-reminder__title" data-tone={open.length > 0 ? "action" : "done"}>
          {summary === null
            ? before
              ? t("Before closing: check today's summary")
              : t("After closing: check today's summary")
            : open.length > 0
              ? before
                ? t("Before closing: {tables} not paid yet · {amount}", owed)
                : t("After closing: {tables} not paid yet · {amount}", owed)
              : earlier.length > 0
                ? before
                  ? t("Before closing: today's tables are all paid")
                  : t("After closing: today's tables are all paid")
                : before
                  ? t("Before closing: every table is paid")
                  : t("After closing: every table is paid")}
        </p>
        {summary === null ? null : (
          <p className="closing-reminder__detail">
            {before
              ? t("Today's net taken {amount} · look over today's summary before you close", {
                  amount: net,
                })
              : t("Today's net taken {amount} · look over today's summary", { amount: net })}
          </p>
        )}
        {earlier.length > 0 ? (
          <p className="closing-reminder__detail">
            {earlierOwedMinor > 0n
              ? t(
                  "Also open from earlier days: {tables} · {amount}, not in today's figures. On Tables, take the payment or record that the guests left without paying, then close each one.",
                  {
                    tables: countOf(earlier.length, "table"),
                    amount: orderMoney({
                      amountMinor: earlierOwedMinor.toString(),
                      currencyCode: "CAD",
                    }),
                  },
                )
              : t(
                  "Also open from earlier days: {tables}, nothing owed. On Tables, close each one.",
                  {
                    tables: countOf(earlier.length, "table"),
                  },
                )}
          </p>
        ) : null}
        {/* DEC-PAID-ORDER-AUTO-ACCEPT: what the shift should know before it goes home. */}
        {stuck > 0 ? (
          <p className="closing-reminder__detail">
            {t("Paid orders the kitchen hasn't started for {minutes} min or more: {count}", {
              minutes: paidOrderAlarmMinutes,
              count: stuck,
            })}
          </p>
        ) : null}
        {cantMake > 0 ? (
          <p className="closing-reminder__detail">
            {t("Refunded with Can't make it in the last 24 hours: {count}", { count: cantMake })}
          </p>
        ) : null}
      </div>
      <Link className="closing-reminder__open" to="/app/reports/operations">
        {t("See today's summary")}
      </Link>
    </section>
  );
}
