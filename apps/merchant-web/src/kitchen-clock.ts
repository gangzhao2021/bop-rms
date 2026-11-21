import { useSyncExternalStore } from "react";

/**
 * WP-2423 follow-up: ticket ages follow the device clock, not the projection time. The projection
 * time only moves when the kitchen's work changes, so a quiet board otherwise freezes every age.
 */
export const kitchenClockTickMs = 30_000;

let current: number | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
function tick() {
  current = Date.now();
  for (const listener of listeners) listener();
}
function onVisibility() {
  if (visible()) tick();
}

/** One shared clock for every card; ticks every 30 s while the page is shown, stops when unused. */
export function subscribeKitchenClock(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    current = Date.now();
    timer = setInterval(() => {
      if (visible()) tick();
    }, kitchenClockTickMs);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", onVisibility);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearInterval(timer);
    timer = undefined;
    current = null;
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** The clock's last tick, or null before anything on the page uses it. */
export const kitchenClockNow = (): number | null => current;

/**
 * The instant ages are measured against: the latest of the device clock, the last successful read
 * and the projection time, so a device clock running slow never shows a negative age.
 */
export function kitchenClockAt(
  projectedAt: string,
  now: number | null,
  checkedAt?: string,
): string {
  const times = [Date.parse(projectedAt)];
  if (now !== null) times.push(now);
  if (checkedAt !== undefined && Number.isFinite(Date.parse(checkedAt)))
    times.push(Date.parse(checkedAt));
  return new Date(Math.max(...times)).toISOString();
}

export function useKitchenClock(projectedAt: string, checkedAt?: string): string {
  const now = useSyncExternalStore(subscribeKitchenClock, kitchenClockNow, kitchenClockNow);
  return kitchenClockAt(projectedAt, now, checkedAt);
}
