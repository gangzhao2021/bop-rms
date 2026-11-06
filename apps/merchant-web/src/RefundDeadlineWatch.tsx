import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { playKitchenChime } from "./alert-chime.js";
import { t } from "./i18n/i18n.js";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";
import {
  refundAlertsDue,
  refundClockMs,
  refundCountdownUnsure,
  refundWarningUnsureText,
  refundWarnings,
  saveLastKnownRefundDeadlines,
  type RefundDeadline,
} from "./refund-deadline-warning.js";
import { storeTime } from "./StoreTime.js";
import { pinnedHeightRef } from "./pinned-warnings.js";

type Warning = ReturnType<typeof refundWarnings>[number];

/**
 * What a person does about the countdown, in staff words. An ordinary pickup waits for Accept; one
 * sent straight to the kitchen has no Accept: a step on its ticket stops it, or "Making it by hand"
 * on Orders (the only way when its ticket never arrived). Mixed lists get one line for each.
 */
export function refundActionLines(
  warnings: readonly Warning[],
  where: {
    readonly signedOut: boolean;
    readonly unsure: boolean;
    readonly canAccept: boolean;
    /** Signed in: whether this person accepts on Orders (false on a kitchen-only screen). */
    readonly onOrders: boolean;
  },
): { readonly accept: string | null; readonly kitchen: string | null } {
  const accepting = warnings.filter((warning) => !warning.kitchenStart);
  const kitchen = warnings.filter((warning) => warning.kitchenStart);
  const one = (list: readonly Warning[]) => list.length === 1;
  const acceptLine =
    accepting.length === 0
      ? null
      : where.signedOut
        ? where.unsure
          ? where.canAccept
            ? t("Sign in to check.")
            : t("Ask someone at the counter to check Orders.")
          : where.canAccept
            ? one(accepting)
              ? t("Sign in to accept it.")
              : t("Sign in to accept them.")
            : one(accepting)
              ? t("Ask someone at the counter to accept it on Orders.")
              : t("Ask someone at the counter to accept them on Orders.")
        : where.onOrders
          ? null
          : one(accepting)
            ? t("Ask someone at the counter to accept it on Orders.")
            : t("Ask someone at the counter to accept them on Orders.");
  const lost = kitchen.some((warning) => warning.notReached);
  const kitchenLine =
    kitchen.length === 0 || (where.signedOut && where.unsure && accepting.length > 0)
      ? null
      : lost
        ? where.onOrders
          ? null
          : where.signedOut && where.canAccept
            ? t("Sign in and tap Making it by hand on Orders if it is being made.")
            : t(
                "Ask someone at the counter to tap Making it by hand on Orders if it is being made.",
              )
        : where.signedOut
          ? where.canAccept
            ? t(
                "Tap a step on the ticket on the kitchen screen, or sign in and tap Making it by hand on Orders.",
              )
            : t("Tap a step on the ticket on the kitchen screen.")
          : where.onOrders
            ? null
            : t("Tap a step on the ticket to keep it.");
  return { accept: acceptLine, kitchen: kitchenLine };
}

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

/** A signed-out screen's re-check of the orders it shows (a registered Store tablet only). */
export type RefundRecheckResult =
  | { readonly kind: "Checked"; readonly deadlines: readonly RefundDeadline[] }
  /** This browser is not a registered Store tablet: nothing can be checked without a sign-in. */
  | { readonly kind: "NoTablet" }
  | { readonly kind: "Failed" };

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
 *
 * v15 cbff9d6f: without a sign-in nothing is read with the old one. A registered Store tablet
 * re-checks only the orders it shows (`recheck`), so an order accepted on another screen leaves
 * the countdown at once. Anywhere else, or when checks fail, once the last check is older than
 * 30 seconds the warning says the order may already have been accepted and stops sounding.
 */
export function RefundDeadlineWatch({
  read,
  ordersHref,
  onOrdersPage,
  now: clock = Date.now,
  readIntervalMs = REFUND_WATCH_READ_MS,
  signedOut = false,
  canAccept = ordersHref !== null,
  initial = null,
  recheck,
  portal = null,
  timeZone,
  remember = false,
  onDeadlines,
}: {
  /** The signed-in read; never used while `signedOut`. */
  readonly read: ((signal: AbortSignal) => Promise<readonly RefundDeadline[] | null>) | null;
  /** Where this person accepts orders; null when they cannot (the kitchen display role). */
  readonly ordersHref: string | null;
  readonly onOrdersPage: boolean;
  readonly now?: () => number;
  readonly readIntervalMs?: number;
  /** No usable sign-in on this screen: the deadlines are the last known, not live. */
  readonly signedOut?: boolean;
  /** Whether whoever signs in here can accept (signed-out screens without a workspace). */
  readonly canAccept?: boolean;
  /** What this tab last knew and when it was checked (signed-out screens). */
  readonly initial?: {
    readonly deadlines: readonly RefundDeadline[];
    readonly checkedAt: number;
  } | null;
  /** Re-checks the shown orders without a sign-in (registered Store tablets). */
  readonly recheck?: (
    orderNumbers: readonly string[],
    signal: AbortSignal,
  ) => Promise<RefundRecheckResult>;
  /** Where to show the warning instead of the top of the page (the signed-out cover). */
  readonly portal?: HTMLElement | null;
  readonly timeZone?: string | undefined;
  /** Keep the last read for this tab so a later signed-out or PIN screen can still show it. */
  readonly remember?: boolean;
  /** Each successful signed-in read (for the Session keep-alive while orders wait). */
  readonly onDeadlines?: (deadlines: readonly RefundDeadline[]) => void;
}) {
  const [deadlines, setDeadlines] = useState<readonly RefundDeadline[]>(
    () => initial?.deadlines ?? [],
  );
  const [checkedAt, setCheckedAt] = useState<number | null>(() => initial?.checkedAt ?? null);
  // Whether a check succeeded since this screen signed out (else "before this screen signed out").
  const [checkedSignedOut, setCheckedSignedOut] = useState(false);
  const [noTablet, setNoTablet] = useState(false);
  const [now, setNow] = useState(clock);
  const latest = useRef({ remember, canAccept, timeZone, onDeadlines, deadlines, recheck });
  latest.current = { remember, canAccept, timeZone, onDeadlines, deadlines, recheck };
  const [announcement, setAnnouncement] = useState("");
  const alerted = useRef(new Set<string>());
  const audio = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!signedOut) return;
    setCheckedSignedOut(false);
    setNoTablet(false);
  }, [signedOut]);
  const canRecheck = recheck !== undefined;
  useEffect(() => {
    // Signed out: only the tablet re-check, and only while it can answer.
    if (signedOut ? !canRecheck || noTablet : read === null) return;
    let active: AbortController | null = null;
    const accept = (next: readonly RefundDeadline[]) => {
      const at = clock();
      setDeadlines(next);
      setCheckedAt(at);
      const options = latest.current;
      if (options.remember)
        saveLastKnownRefundDeadlines({
          deadlines: next,
          checkedAt: at,
          canAccept: options.canAccept,
          timeZone: options.timeZone ?? null,
        });
      return at;
    };
    const load = () => {
      if (active !== null) return;
      const options = latest.current;
      const at = clock();
      const shown = options.deadlines
        .filter((deadline) => Date.parse(deadline.acceptBy) > at)
        .map((deadline) => deadline.orderNumber);
      // WP-2423 M61: a tablet re-checks even with nothing shown, so a paid order placed after the
      // last person left it is warned about here too.
      if (signedOut && options.recheck === undefined) return;
      const controller = new AbortController();
      active = controller;
      const work: Promise<unknown> =
        signedOut && options.recheck !== undefined
          ? options.recheck([...new Set(shown)].slice(0, 10), controller.signal).then((result) => {
              if (controller.signal.aborted) return;
              if (result.kind === "NoTablet") setNoTablet(true);
              if (result.kind !== "Checked") return;
              accept(result.deadlines);
              setCheckedSignedOut(true);
            })
          : read === null
            ? Promise.resolve()
            : read(controller.signal).then((next) => {
                if (controller.signal.aborted || next === null) return;
                accept(next);
                latest.current.onDeadlines?.(next);
              });
      void work
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
  }, [canRecheck, clock, noTablet, read, readIntervalMs, signedOut]);
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
  // UI refresh: the warning is pinned to the top edge; pages that pin their own bar (Orders
  // filters, Counter order categories, Tables details) sit below it through this height.
  // Stacked with the paid order alarm under it; the page's sticky parts sit below both.
  const pinWarning = useMemo(() => pinnedHeightRef("refund"), []);
  const warnings = refundWarnings(deadlines, now);
  // Out of date without a sign-in: no sound or announcement for an order that may be handled.
  const unsure = refundCountdownUnsure(signedOut, checkedAt, now);
  useEffect(() => {
    if (unsure) return;
    const due = refundAlertsDue(warnings, alerted.current);
    if (due.keys.length === 0) return;
    for (const key of due.keys) alerted.current.add(key);
    if (due.announce !== null) setAnnouncement(due.announce);
    if (due.chime) playKitchenChime(audio.current ?? undefined);
  });
  if (warnings.length === 0) return null;
  const checked =
    checkedAt === null
      ? ""
      : " " +
        (checkedSignedOut
          ? t("Last checked at {time}.", {
              time: storeTime(new Date(checkedAt).toISOString(), timeZone),
            })
          : t("Last checked at {time}, before this screen signed out.", {
              time: storeTime(new Date(checkedAt).toISOString(), timeZone),
            }));
  // Signed in on Orders, a person accepts or taps Making it by hand right there; elsewhere a person
  // who can accept gets the link, and a kitchen-only screen says who can.
  const lines = refundActionLines(warnings, {
    signedOut,
    unsure,
    canAccept,
    onOrders: !signedOut && ordersHref !== null,
  });
  const anyLost = warnings.some((warning) => warning.kitchenStart && warning.notReached);
  const section = (
    <section
      ref={pinWarning}
      className="refund-deadline-warning"
      data-tier={unsure ? "unsure" : warnings[0]?.tier}
      data-signed-out={signedOut ? "true" : undefined}
      aria-label={t("Orders about to be refunded")}
    >
      {/* Heard once per new step (5 min, 2 min, 30 s); the countdown itself stays quiet. */}
      <p className="visually-hidden" role="alert">
        {unsure ? "" : announcement}
      </p>
      <ul>
        {warnings.map((warning) => (
          <li key={warning.orderNumber + warning.acceptBy} data-tier={warning.tier}>
            {unsure ? refundWarningUnsureText(warning.orderNumber, warning.leftMs) : warning.text}
          </li>
        ))}
      </ul>
      {signedOut ? (
        lines.accept === null && lines.kitchen === null && checked === "" ? null : (
          <p>
            {[lines.accept, lines.kitchen].filter((line) => line !== null).join(" ")}
            {checked}
          </p>
        )
      ) : (
        <>
          {lines.accept === null && lines.kitchen === null ? null : (
            <p>{[lines.accept, lines.kitchen].filter((line) => line !== null).join(" ")}</p>
          )}
          {ordersHref === null ||
          onOrdersPage ||
          warnings.every((warning) => warning.kitchenStart && !warning.notReached) ? null : (
            <Link className="shell-action" to={ordersHref}>
              {warnings.some((warning) => !warning.kitchenStart) || !anyLost
                ? t("Accept on Orders")
                : t("Making it by hand on Orders")}
            </Link>
          )}
        </>
      )}
    </section>
  );
  return portal === null ? section : createPortal(section, portal);
}
