import { useSyncExternalStore } from "react";

/**
 * v15 cbff9d6f (DEC-STAFF-SESSION-CONTINUITY 2026-10-17 correction): once this screen's sign-in
 * has ended (the signed-out cover is up), nothing on it keeps reading with that sign-in — Orders,
 * Home, alerts, the kitchen and pickup boards, retries and the business-day check all stop instead
 * of collecting refusals every few seconds. They start again on their own if "Check again" finds
 * the sign-in still valid; a new sign-in loads the screen afresh. One value per browser tab.
 */
let ended = false;
const listeners = new Set<() => void>();

/** Called by the session guard when the cover goes up (true) or comes down (false). */
export function setStaffSessionEnded(value: boolean): void {
  if (ended === value) return;
  ended = value;
  for (const listener of [...listeners]) listener();
}

export function staffSessionEnded(): boolean {
  return ended;
}

export function subscribeStaffSessionEnded(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a background read may run: the tab is visible and its sign-in has not ended. */
export function backgroundReadAllowed(
  visible: boolean = typeof document === "undefined" || document.visibilityState === "visible",
): boolean {
  return visible && !ended;
}

/** True while this screen's sign-in is usable; periodic reads stop when it turns false. */
export function useStaffSessionLive(): boolean {
  return !useSyncExternalStore(subscribeStaffSessionEnded, staffSessionEnded, () => false);
}
