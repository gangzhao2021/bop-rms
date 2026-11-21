import type { StoreProfile } from "./store-profile-client.js";

/**
 * WP-2423 store-service-controls (v15 M30/M34): whether a guest can start a new order or add to
 * one right now, from the Store's published facts the guest's own session reads. "Unknown" never
 * blocks anything (the server still decides); it only means no notice is shown.
 */
export type StoreServicePhase = "Unknown" | "Open" | "Soon" | "Stopped" | "Paused" | "Closed";

/** Last orders within this long is said ahead (a countdown on the menu, cart and checkout). */
export const lastOrdersSoonSeconds = 30 * 60;
/** How often an open page reads the Store again, besides at each boundary. */
export const storeServiceReadMs = 60_000;

const seconds = (value: string): number => {
  const [hour = 0, minute = 0, second = 0] = value.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
};

/** The Store's local clock now, in seconds after midnight; null when the zone can't be read. */
export function storeLocalSeconds(timeZone: string, at: number): number | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(at))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    ) as { hour?: number; minute?: number; second?: number };
    if (parts.hour === undefined || parts.minute === undefined || parts.second === undefined)
      return null;
    return parts.hour * 3600 + parts.minute * 60 + parts.second;
  } catch {
    return null;
  }
}

export function storeServicePhase(
  profile: StoreProfile | null,
  at: number,
): { readonly phase: StoreServicePhase; readonly minutesLeft: number | null } {
  const hours = profile?.hours ?? null;
  if (profile === null || hours === null) return { phase: "Unknown", minutesLeft: null };
  if (hours.status === "Paused") return { phase: "Paused", minutesLeft: null };
  if (hours.status === "Closed") return { phase: "Closed", minutesLeft: null };
  if (hours.ordersStopped) return { phase: "Stopped", minutesLeft: null };
  const now = storeLocalSeconds(profile.timeZone, at);
  if (hours.lastOrdersAt !== null && now !== null) {
    // Only the countdown follows the clock; the Store's own answer says when orders stopped (read
    // again one second after last orders).
    const left = seconds(hours.lastOrdersAt) - now;
    if (left > 0 && left <= lastOrdersSoonSeconds)
      return { phase: "Soon", minutesLeft: Math.max(1, Math.ceil(left / 60)) };
  }
  return { phase: "Open", minutesLeft: null };
}

/** A new order or new items can be sent from the phone (unknown never blocks). */
export const takesNewOrders = (phase: StoreServicePhase): boolean =>
  phase === "Unknown" || phase === "Open" || phase === "Soon";

/**
 * Milliseconds until the next moment the answer can change (last orders, the end of a pause, the
 * closing time), plus one second; null when none is due within the re-read interval.
 */
export function nextStoreBoundaryMs(profile: StoreProfile | null, at: number): number | null {
  const hours = profile?.hours ?? null;
  if (profile === null || hours === null) return null;
  const now = storeLocalSeconds(profile.timeZone, at);
  if (now === null) return null;
  const due = [hours.lastOrdersAt, hours.pausedUntil, hours.closesAt]
    .filter((value): value is string => value !== null)
    .flatMap((value) => {
      const left = seconds(value) - now;
      // The countdown starts 30 minutes before last orders.
      const soon = value === hours.lastOrdersAt ? left - lastOrdersSoonSeconds : -1;
      return [left, soon].filter((s) => s > 0);
    });
  if (due.length === 0) return null;
  const ms = Math.min(...due) * 1000 + 1000;
  return ms < storeServiceReadMs ? ms : null;
}
