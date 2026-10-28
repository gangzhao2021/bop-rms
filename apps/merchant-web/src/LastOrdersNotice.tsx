import { useEffect, useState } from "react";
import { displayLocale, t } from "./i18n/i18n.js";
import { loadStoreBusinessDay } from "./StoreBusinessDay.js";
import { useStaffSessionLive } from "./staff-session-reads.js";

/**
 * WP-2423 item 8 ③ follow-up (v15 2026-10-28): guests can't send orders or rounds from their
 * phones after the Store's last orders (its published "stop taking orders N minutes before
 * closing"). Servers see it coming on the Tables page: from 30 minutes before, when it is, and
 * after it, that they can still add a round for a table (recorded as theirs).
 */
export const lastOrdersWarningMs = 30 * 60_000;
const rereadMs = 5 * 60_000;

export function lastOrdersText(
  lastOrdersAt: string | null,
  now: number,
  timeZone?: string,
): { readonly tone: "soon" | "past"; readonly text: string } | null {
  if (lastOrdersAt === null) return null;
  const at = Date.parse(lastOrdersAt);
  if (!Number.isFinite(at) || now < at - lastOrdersWarningMs) return null;
  const time = new Intl.DateTimeFormat(displayLocale(), {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(at));
  return now < at
    ? {
        tone: "soon",
        text: t(
          "Last orders at {time}. After that guests can't order from their phones; you can still add a round for a table.",
          { time },
        ),
      }
    : {
        tone: "past",
        text: t(
          "Guests stopped ordering from their phones at {time} (last orders). You can still add a round for a table.",
          { time },
        ),
      };
}

/** The current period's last orders, read now and every few minutes while the page is open. */
export function useLastOrders(fetcher?: typeof fetch): string | null {
  const live = useStaffSessionLive();
  const [lastOrdersAt, setLastOrdersAt] = useState<string | null>(null);
  useEffect(() => {
    if (!live) return;
    let controller = new AbortController();
    const read = () => {
      controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      loadStoreBusinessDay(fetcher, signal)
        .then((day) => {
          if (!signal.aborted) setLastOrdersAt(day.lastOrdersAt);
        })
        .catch(() => {
          /* Not known: no notice rather than a guessed time. */
        });
    };
    read();
    const timer = setInterval(read, rereadMs);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [live, fetcher]);
  return lastOrdersAt;
}

export function LastOrdersNotice({
  timeZone,
  fetcher,
}: {
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const lastOrdersAt = useLastOrders(fetcher);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (lastOrdersAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [lastOrdersAt]);
  const notice = lastOrdersText(lastOrdersAt, now, timeZone);
  if (notice === null) return null;
  return (
    <p className="last-orders-notice" role="status" data-tone={notice.tone}>
      {notice.text}
    </p>
  );
}
