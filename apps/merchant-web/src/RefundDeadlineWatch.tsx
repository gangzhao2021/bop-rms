import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { playKitchenChime } from "./alert-chime.js";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";
import {
  refundAlertsDue,
  refundClockMs,
  refundWarnings,
  saveLastKnownRefundDeadlines,
  type RefundDeadline,
} from "./refund-deadline-warning.js";
import { storeTime } from "./StoreTime.js";

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
 *
 * v15 c9b377cb defect 2: when this screen's sign-in ends (or there is none, e.g. the PIN screen) the
 * warning stays in view where staff are looking — inside the signed-out cover via `portal` — with
 * the time it was last checked and "Sign in to accept it" instead of a link that cannot work. It
 * never sounds or announces without the same words on screen.
 */
export function RefundDeadlineWatch({
  read,
  ordersHref,
  onOrdersPage,
  now: clock = Date.now,
  readIntervalMs = REFUND_WATCH_READ_MS,
  signedOut = false,
  canAccept = ordersHref !== null,
  lastCheckedAt,
  portal = null,
  timeZone,
  remember = false,
  onDeadlines,
}: {
  readonly read: (signal: AbortSignal) => Promise<readonly RefundDeadline[] | null>;
  /** Where this person accepts orders; null when they cannot (the kitchen display role). */
  readonly ordersHref: string | null;
  readonly onOrdersPage: boolean;
  readonly now?: () => number;
  readonly readIntervalMs?: number;
  /** No usable sign-in on this screen: the deadlines are the last known, not live. */
  readonly signedOut?: boolean;
  /** Whether whoever signs in here can accept (signed-out screens without a workspace). */
  readonly canAccept?: boolean;
  /** When the deadlines were last read (signed-out screens showing a remembered copy). */
  readonly lastCheckedAt?: number;
  /** Where to show the warning instead of the top of the page (the signed-out cover). */
  readonly portal?: HTMLElement | null;
  readonly timeZone?: string | undefined;
  /** Keep the last read for this tab so a later signed-out or PIN screen can still show it. */
  readonly remember?: boolean;
  /** Each successful read (for the Session keep-alive while orders wait for acceptance). */
  readonly onDeadlines?: (deadlines: readonly RefundDeadline[]) => void;
}) {
  const [deadlines, setDeadlines] = useState<readonly RefundDeadline[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(clock);
  const latest = useRef({ remember, canAccept, timeZone, onDeadlines });
  latest.current = { remember, canAccept, timeZone, onDeadlines };
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
          if (controller.signal.aborted || next === null) return;
          const at = clock();
          setDeadlines(next);
          setCheckedAt(at);
          const options = latest.current;
          options.onDeadlines?.(next);
          if (options.remember)
            saveLastKnownRefundDeadlines({
              deadlines: next,
              checkedAt: at,
              canAccept: options.canAccept,
              timeZone: options.timeZone ?? null,
            });
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
  if (warnings.length === 0) return null;
  const them = warnings.length === 1 ? "it" : "them";
  const checked = lastCheckedAt ?? checkedAt;
  const section = (
    <section
      className="refund-deadline-warning"
      data-tier={warnings[0]?.tier}
      data-signed-out={signedOut ? "true" : undefined}
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
      {signedOut ? (
        <p>
          {canAccept
            ? `Sign in to accept ${them}.`
            : `Ask someone at the counter to accept ${them} on Orders.`}
          {checked === null
            ? null
            : ` Last checked at ${storeTime(new Date(checked).toISOString(), timeZone)}, before this screen signed out.`}
        </p>
      ) : ordersHref === null ? (
        <p>Ask someone at the counter to accept {them} on Orders.</p>
      ) : onOrdersPage ? null : (
        <Link className="shell-action" to={ordersHref}>
          Accept on Orders
        </Link>
      )}
    </section>
  );
  return portal === null ? section : createPortal(section, portal);
}
