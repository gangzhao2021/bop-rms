import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { countOf, t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
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
 * WP-2423 item 8 ② (Figma 47-2, home snippet): on Home, around the Store's closing, tell the Owner
 * or Store Manager what is still open — tables not paid yet and today's net taken — with one step:
 * see today's summary. Read once when shown and every 5 minutes while it shows.
 */
export function ClosingReminder({
  screens,
  fetcher,
}: {
  readonly screens: readonly string[];
  readonly fetcher?: typeof fetch | undefined;
}) {
  const day = useStoreBusinessDay();
  const live = useStaffSessionLive();
  const client = useMemo(() => createStoreReportsClient(fetcher), [fetcher]);
  const [now, setNow] = useState(() => Date.now());
  const [summary, setSummary] = useState<TonightSummary | null>(null);
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
          if (!signal.aborted) setSummary(value);
        })
        .catch(() => {
          /* The reminder keeps its last figures; the summary page says when it can't read. */
        });
    };
    read();
    const timer = setInterval(read, rereadMs);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [show, live, client]);
  if (!show) return null;
  const open = summary?.openTables.filter((table) => table.owedMinor !== "0") ?? [];
  if (phase === "UnpaidTablesOnly" && open.length === 0) return null;
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
        : orderMoney({ amountMinor: summary.openTablesOwedMinor, currencyCode: "CAD" }),
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
      </div>
      <Link className="closing-reminder__open" to="/app/reports/operations">
        {t("See today's summary")}
      </Link>
    </section>
  );
}
