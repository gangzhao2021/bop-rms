/**
 * WP-2423 (same-table-ordering): how a table cart (and its checkout) keeps up with the other
 * phones. One small read every 4 s while the page is on screen and online; nothing while hidden or
 * offline (a return to the page or to the network reads at once); after a failed read the wait
 * doubles up to a minute, so an outage or a busy server is never answered with more load.
 */
export const tableCartPollIntervalMs = 4_000;
export const tableCartPollMaxDelayMs = 60_000;

/** The wait before the next read after `failures` failed reads in a row. */
export function tableCartPollDelay(failures: number): number {
  if (failures <= 0) return tableCartPollIntervalMs;
  return Math.min(tableCartPollMaxDelayMs, tableCartPollIntervalMs * 2 ** Math.min(failures, 10));
}

export interface TableCartPollOptions {
  /** One read; resolves whether it worked. */
  readonly read: () => Promise<boolean>;
  /** Whether a read may happen now (nothing on its way, the page in a state that reads). */
  readonly shouldRead: () => boolean;
  readonly visible: () => boolean;
  readonly online: () => boolean;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export function startTableCartPoll(options: TableCartPollOptions) {
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number) => window.setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => window.clearTimeout(handle as number));
  let failures = 0;
  let timer: unknown = null;
  let reading = false;
  let stopped = false;
  const schedule = (ms: number) => {
    if (stopped || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, ms);
  };
  const tick = async () => {
    if (stopped || reading) return;
    // Hidden or offline: wait for `wake` (page shown again, network back) instead of reading.
    if (!options.visible() || !options.online()) return;
    if (!options.shouldRead()) {
      schedule(tableCartPollIntervalMs);
      return;
    }
    reading = true;
    const ok = await options.read().then(
      (value) => value,
      () => false,
    );
    reading = false;
    failures = ok ? 0 : failures + 1;
    schedule(tableCartPollDelay(failures));
  };
  schedule(tableCartPollIntervalMs);
  return Object.freeze({
    /**
     * The page came back on screen: read now (after a failure, keep the wait). The network came
     * back (`reconnected`): the failures were the network's, so read right away from any state.
     * The read waits one turn, so the page has heard of the network first.
     */
    wake(reason: "shown" | "reconnected" = "shown") {
      if (!stopped && reason === "reconnected") {
        failures = 0;
        if (timer !== null) clearTimer(timer);
        timer = null;
        schedule(0);
        return;
      }
      if (stopped || failures > 0) {
        if (!stopped && timer === null) schedule(tableCartPollDelay(failures));
        return;
      }
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  });
}
