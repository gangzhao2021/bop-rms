/**
 * M02 (v15 07b7a1b7): "This table isn't open yet" continues by itself once staff open the table.
 *
 * WP-2423 (guest-waits-and-refund-lock, v15 batch 31): a guest whose page checked by entering again
 * (every entry attempt counts against the Store's guest-entry budget, so it checked after 20 s, then
 * every 40 s to 2 minutes) waited up to a minute after staff opened the table. The page now asks a
 * cheap "is it open now?" on a budget of its own (guestTableWaitPolicy): every 3 s for the first
 * 2 minutes, every 10 s to 5 minutes, every 30 s to 15 minutes, then it stops and says so (the
 * guest's "We've been seated" asks again). Only while the page is in front; once more when the guest
 * comes back to it; never sooner than a busy answer's Retry-After. At most 70 checks in any ten
 * minutes (the identity package's admission test proves a room of waiting phones leaves new scans
 * room to get in).
 */
export const tableWaitCheckDelaysSeconds: readonly number[] = Object.freeze([
  ...Array<number>(40).fill(3),
  ...Array<number>(18).fill(10),
  ...Array<number>(20).fill(30),
]);
/**
 * A client with no cheap check (a demo entry) checks by entering again, on the entry's budget:
 * after 20 s, backing off to every 2 minutes, at most 6 checks in any ten minutes.
 */
export const tableOpenRecheckDelaysSeconds: readonly number[] = Object.freeze([
  20, 40, 80, 120, 120, 120, 120, 120, 120, 120,
]);
/** Coming back to the page checks again, but not sooner than this after the last check. */
export const tableOpenRecheckMinimumGapSeconds = 20;

/**
 * What a check found: true, still waiting; false, anything else answered (stop); `{ waitSeconds }`,
 * still waiting and the store asked this phone not to ask again before then.
 */
export type TableOpenCheckResult = boolean | { readonly waitSeconds: number };

export interface TableOpenRecheckBoundary {
  readonly check: () => Promise<TableOpenCheckResult>;
  readonly visible: () => boolean;
  /** Calls back when the page comes to the front; returns the unsubscribe. */
  readonly onVisible: (listener: () => void) => () => void;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
  readonly delaysSeconds?: readonly number[];
  readonly minimumGapSeconds?: number;
  /** The schedule ran out with the table still not open: the page says it stopped checking. */
  readonly onExhausted?: () => void;
}

/** Starts waiting; returns `{ checkNow, stop }`. `checkNow` also starts a stopped schedule again. */
export function watchTableOpening(boundary: TableOpenRecheckBoundary): {
  readonly checkNow: () => void;
  readonly stop: () => void;
} {
  const delays = boundary.delaysSeconds ?? tableOpenRecheckDelaysSeconds;
  const minimumGapMs = (boundary.minimumGapSeconds ?? tableOpenRecheckMinimumGapSeconds) * 1000;
  let index = 0;
  let timer: unknown = null;
  let stopped = false;
  let busy = false;
  let missed = false;
  let lastCheck = boundary.now();
  /** Not before this instant (a busy answer's Retry-After). */
  let notBefore = 0;
  const clear = () => {
    if (timer !== null) boundary.clearTimer(timer);
    timer = null;
  };
  const stop = () => {
    stopped = true;
    clear();
    unsubscribe();
  };
  /** Checks once; resolves true while still waiting. */
  const check = async (): Promise<boolean> => {
    if (stopped || busy) return !stopped;
    busy = true;
    missed = false;
    lastCheck = boundary.now();
    try {
      const result = await boundary.check();
      if (result === false) {
        stop();
        return false;
      }
      if (typeof result === "object")
        notBefore = boundary.now() + Math.max(0, result.waitSeconds) * 1000;
    } catch {
      /* Still waiting: the next check asks again. */
    } finally {
      busy = false;
    }
    return !stopped;
  };
  const schedule = () => {
    if (stopped || timer !== null) return;
    if (index >= delays.length) {
      boundary.onExhausted?.();
      return;
    }
    const seconds = delays[index] ?? 0;
    index += 1;
    const wait = Math.max(seconds * 1000, notBefore - boundary.now());
    timer = boundary.setTimer(() => {
      timer = null;
      // Hidden: no request; the check happens when the guest is back.
      if (boundary.visible()) void check().then(schedule);
      else {
        missed = true;
        schedule();
      }
    }, wait);
  };
  const unsubscribe = boundary.onVisible(() => {
    if (stopped || boundary.now() < notBefore) return;
    if (missed || boundary.now() - lastCheck >= minimumGapMs) void check();
  });
  schedule();
  return Object.freeze({
    checkNow: () => {
      if (stopped) return;
      // The guest asked: at once, and if the schedule had run out, it starts again.
      const ranOut = timer === null && index >= delays.length;
      void check().then((waiting) => {
        if (!waiting || !ranOut) return;
        index = 0;
        schedule();
      });
    },
    stop,
  });
}
