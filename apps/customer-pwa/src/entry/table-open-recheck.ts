/**
 * M02 (v15 07b7a1b7): "This table isn't open yet" continues by itself once staff open the table.
 *
 * Every check is an entry attempt and counts against the Store's guest-entry budget (per address
 * and per Store in ten minutes, guestSessionAbusePolicy), so a waiting phone checks rarely: after
 * 20 s, then backing off to every 2 minutes, only while the page is in front, and once more when
 * the guest comes back to it. At most 6 checks in any ten minutes (the identity package's
 * admission test proves a room of waiting phones leaves new scans room to get in); the guest can
 * also say "We've been seated".
 */
export const tableOpenRecheckDelaysSeconds: readonly number[] = Object.freeze([
  20, 40, 80, 120, 120, 120, 120, 120, 120, 120,
]);
/** Coming back to the page checks again, but not sooner than this after the last check. */
export const tableOpenRecheckMinimumGapSeconds = 20;

export interface TableOpenRecheckBoundary {
  /** True while the guest is still waiting (keep checking); false once anything else answered. */
  readonly check: () => Promise<boolean>;
  readonly visible: () => boolean;
  /** Calls back when the page comes to the front; returns the unsubscribe. */
  readonly onVisible: (listener: () => void) => () => void;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
  readonly delaysSeconds?: readonly number[];
}

/** Starts waiting; returns `{ checkNow, stop }`. */
export function watchTableOpening(boundary: TableOpenRecheckBoundary): {
  readonly checkNow: () => void;
  readonly stop: () => void;
} {
  const delays = boundary.delaysSeconds ?? tableOpenRecheckDelaysSeconds;
  let index = 0;
  let timer: unknown = null;
  let stopped = false;
  let busy = false;
  let missed = false;
  let lastCheck = boundary.now();
  const stop = () => {
    stopped = true;
    if (timer !== null) boundary.clearTimer(timer);
    timer = null;
    unsubscribe();
  };
  const check = async () => {
    if (stopped || busy) return;
    busy = true;
    missed = false;
    lastCheck = boundary.now();
    try {
      if (!(await boundary.check())) stop();
    } catch {
      /* Still waiting: the next check asks again. */
    } finally {
      busy = false;
    }
  };
  const schedule = () => {
    if (stopped || index >= delays.length) return;
    const seconds = delays[index] ?? 0;
    index += 1;
    timer = boundary.setTimer(() => {
      timer = null;
      // Hidden: no request; the check happens when the guest is back.
      if (boundary.visible()) void check().then(schedule);
      else {
        missed = true;
        schedule();
      }
    }, seconds * 1000);
  };
  const unsubscribe = boundary.onVisible(() => {
    if (stopped) return;
    if (missed || boundary.now() - lastCheck >= tableOpenRecheckMinimumGapSeconds * 1000)
      void check();
  });
  schedule();
  return Object.freeze({
    checkNow: () => void check(),
    stop,
  });
}
