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
 * When the reminder shows: the last 8 hours of the business day (from 20:00 with the usual 04:00
 * cut-off). The Store's closing time is not read here; an evening is when a restaurant closes.
 */
export const closingReminderHours = 8;
const rereadMs = 5 * 60_000;

export function inClosingWindow(endsAt: string | null, now: number): boolean {
  if (endsAt === null) return false;
  const left = Date.parse(endsAt) - now;
  return left > 0 && left <= closingReminderHours * 3_600_000;
}

/**
 * WP-2423 item 8 ② (Figma 47-2, home snippet): on Home, in the evening, tell the Owner or Store
 * Manager what is still open before closing — tables not paid yet and tonight's net taken — with
 * one step: see tonight's summary. Read once when shown and every 5 minutes while it shows.
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
  const show = allowed && inClosingWindow(day?.endsAt ?? null, now);
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
  return (
    <section className="closing-reminder" aria-label={t("Before closing")}>
      <div>
        <p className="closing-reminder__title" data-tone={open.length > 0 ? "action" : "done"}>
          {summary === null
            ? t("Before closing: check tonight's summary")
            : open.length > 0
              ? t("Before closing: {tables} not paid yet · {amount}", {
                  tables: countOf(open.length, "table"),
                  amount: orderMoney({
                    amountMinor: summary.openTablesOwedMinor,
                    currencyCode: "CAD",
                  }),
                })
              : t("Before closing: every table is paid")}
        </p>
        {summary === null ? null : (
          <p className="closing-reminder__detail">
            {t("Tonight's net taken {amount} · look over tonight's summary before you close", {
              amount: orderMoney({
                amountMinor: summary.report.summary.netCollectedMinor,
                currencyCode: "CAD",
              }),
            })}
          </p>
        )}
      </div>
      <Link className="closing-reminder__open" to="/app/reports/operations">
        {t("See tonight")}
      </Link>
    </section>
  );
}
