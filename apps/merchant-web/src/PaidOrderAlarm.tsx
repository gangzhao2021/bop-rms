import { createContext, useEffect, useRef, useState } from "react";
import { playKitchenChime } from "./alert-chime.js";
import { paidOrderAlarm, paidOrderAlarmLines, type PaidOrderWatch } from "./paid-order-watch.js";

/** What the Store's paid order watch last said, for any page that shows part of it. */
export const PaidOrderWatchContext = createContext<PaidOrderWatch | null>(null);

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: the warning that replaces the 30-minute refund on table rounds.
 * On every merchant screen, the kitchen board included, because a shop using this has stopped
 * watching Orders. It chimes once at 5 minutes and once at 10, never per order.
 */
export function PaidOrderAlarmBanner({
  watch,
  now: clock = Date.now,
}: {
  readonly watch: PaidOrderWatch | null;
  readonly now?: () => number;
}) {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const timer = setInterval(() => setNow(clock()), 15_000);
    return () => clearInterval(timer);
  }, [clock]);
  const alarm = paidOrderAlarm(watch, Math.max(now, clock()));
  const chimed = useRef(new Set<string>());
  const audio = useRef<AudioContext | null>(null);
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
  const chimeKey = alarm === null ? null : `${alarm.key}|${alarm.tier}`;
  useEffect(() => {
    if (chimeKey === null || chimed.current.has(chimeKey)) return;
    chimed.current.add(chimeKey);
    playKitchenChime(audio.current ?? undefined);
  }, [chimeKey]);
  if (alarm === null) return null;
  return (
    <section
      className="refund-deadline-warning"
      data-tier={alarm.tier === 2 ? "urgent" : "warning"}
      role="alert"
    >
      <ul>
        {paidOrderAlarmLines(alarm).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}
