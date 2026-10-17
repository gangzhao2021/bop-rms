import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { playKitchenChime } from "./alert-chime.js";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";
import {
  refundAlertsDue,
  refundClockMs,
  refundWarnings,
  type RefundDeadline,
} from "./refund-deadline-warning.js";

/** How often the warning re-reads the Store's paid orders waiting for acceptance. */
export const REFUND_WATCH_READ_MS = 15_000;

/** Paid pickup orders with a running refund deadline, from the Orders list (not a chosen refund). */
export function refundDeadlinesFromOrders(view: CurrentOrderQueue): readonly RefundDeadline[] {
  return view.items.flatMap((order) =>
    order.acceptBy === null || order.acceptanceHold?.refundChosen === true
      ? []
      : [{ orderNumber: order.orderNumber, acceptBy: order.acceptBy }],
  );
}

/**
 * WP-2423 pilot rule "Warn before timeouts": shown on every merchant screen (Home, Orders, Kitchen,
 * Tables and the rest) so staff working anywhere hear and see that a paid order nobody accepted is
 * about to be refunded. A failed read keeps the last deadlines counting down; they do not move
 * unless the Store records a new one.
 */
export function RefundDeadlineWatch({
  read,
  ordersHref,
  onOrdersPage,
  now: clock = Date.now,
  readIntervalMs = REFUND_WATCH_READ_MS,
}: {
  readonly read: (signal: AbortSignal) => Promise<readonly RefundDeadline[] | null>;
  /** Where this person accepts orders; null when they cannot (the kitchen display role). */
  readonly ordersHref: string | null;
  readonly onOrdersPage: boolean;
  readonly now?: () => number;
  readonly readIntervalMs?: number;
}) {
  const [deadlines, setDeadlines] = useState<readonly RefundDeadline[]>([]);
  const [now, setNow] = useState(clock);
  const [announcement, setAnnouncement] = useState("");
  const alerted = useRef(new Set<string>());
  const audio = useRef<AudioContext | null>(null);
  useEffect(() => {
    let active: AbortController | null = null;
    const load = () => {
      if (active !== null) return;
      const controller = new AbortController();
      active = controller;
      void read(controller.signal)
        .then((next) => {
          if (!controller.signal.aborted && next !== null) setDeadlines(next);
        })
        .catch(() => undefined)
        .finally(() => {
          if (active === controller) active = null;
          if (!controller.signal.aborted) setNow(clock());
        });
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, readIntervalMs);
    const visible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      active?.abort();
    };
  }, [clock, read, readIntervalMs]);
  // Browsers play sound only after someone touched the page; any tap or key on any screen allows it.
  useEffect(() => {
    const unlock = () => {
      try {
        const Audio = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
        audio.current ??= Audio ? new Audio() : null;
        if (audio.current?.state === "suspended") void audio.current.resume();
      } catch {
        audio.current = null;
      }
    };
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    return () => {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
  }, []);
  const tickMs = refundClockMs(deadlines, now);
  useEffect(() => {
    if (tickMs === null) return;
    const timer = setInterval(() => setNow(clock()), tickMs);
    return () => clearInterval(timer);
  }, [clock, tickMs]);
  const warnings = refundWarnings(deadlines, now);
  useEffect(() => {
    const due = refundAlertsDue(warnings, alerted.current);
    if (due.keys.length === 0) return;
    for (const key of due.keys) alerted.current.add(key);
    if (due.announce !== null) setAnnouncement(due.announce);
    if (due.chime) playKitchenChime(audio.current ?? undefined);
  });
  return (
    <>
      {warnings.length === 0 ? null : (
        <section
          className="refund-deadline-warning"
          data-tier={warnings[0]?.tier}
          aria-label="Orders about to be refunded"
        >
          {/* Heard once per new step (5 min, 2 min, 30 s); the countdown itself stays quiet. */}
          <p className="visually-hidden" role="alert">
            {announcement}
          </p>
          <ul>
            {warnings.map((warning) => (
              <li key={warning.orderNumber + warning.acceptBy} data-tier={warning.tier}>
                {warning.text}
              </li>
            ))}
          </ul>
          {ordersHref === null ? (
            <p>
              Ask someone at the counter to accept {warnings.length === 1 ? "it" : "them"} on
              Orders.
            </p>
          ) : onOrdersPage ? null : (
            <Link className="shell-action" to={ordersHref}>
              Accept on Orders
            </Link>
          )}
        </section>
      )}
    </>
  );
}
