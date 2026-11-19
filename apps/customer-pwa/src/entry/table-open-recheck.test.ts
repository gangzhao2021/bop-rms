import { describe, expect, it, vi } from "vitest";
import {
  tableOpenRecheckDelaysSeconds,
  tableOpenRecheckMinimumGapSeconds,
  tableWaitCheckDelaysSeconds,
  watchTableOpening,
  type TableOpenCheckResult,
} from "./table-open-recheck.js";

function harness(
  results: TableOpenCheckResult[] = [],
  options: { delaysSeconds?: readonly number[]; minimumGapSeconds?: number } = {},
) {
  let now = 0;
  let visible = true;
  const timers: { at: number; callback: () => void }[] = [];
  let listener: (() => void) | null = null;
  const check = vi.fn(async (): Promise<TableOpenCheckResult> => results.shift() ?? true);
  const exhausted = vi.fn();
  const watcher = watchTableOpening({
    check,
    visible: () => visible,
    onVisible: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    now: () => now,
    setTimer: (callback, milliseconds) => {
      const timer = { at: now + milliseconds, callback };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => timers.splice(timers.indexOf(timer as never), 1),
    onExhausted: exhausted,
    ...options,
  });
  const advance = async (seconds: number) => {
    const until = now + seconds * 1000;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (next === undefined || next.at > until) break;
      timers.shift();
      now = next.at;
      next.callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    now = until;
  };
  return {
    watcher,
    check,
    exhausted,
    advance,
    hide: () => {
      visible = false;
    },
    show: async () => {
      visible = true;
      listener?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    pending: () => timers.length,
    subscribed: () => listener !== null,
  };
}

describe("M02 a table not open yet continues by itself, sparing the entry budget", () => {
  it("checks after 20 s, backs off to 2 minutes, and at most 6 times in any ten minutes", async () => {
    expect(tableOpenRecheckDelaysSeconds[0]).toBe(20);
    const at: number[] = [];
    let total = 0;
    for (const seconds of tableOpenRecheckDelaysSeconds) at.push((total += seconds));
    for (const start of at)
      expect(at.filter((t) => t >= start && t < start + 600).length).toBeLessThanOrEqual(6);
    const h = harness();
    await h.advance(19);
    expect(h.check).not.toHaveBeenCalled();
    await h.advance(1);
    expect(h.check).toHaveBeenCalledTimes(1);
    await h.advance(600 - 20);
    expect(h.check).toHaveBeenCalledTimes(6);
    await h.advance(3600);
    expect(h.check).toHaveBeenCalledTimes(tableOpenRecheckDelaysSeconds.length);
    expect(h.pending()).toBe(0);
  });

  it("stops as soon as anything other than 'not open' answers (open, a limit)", async () => {
    const h = harness([true, false]);
    await h.advance(20 + 40);
    expect(h.check).toHaveBeenCalledTimes(2);
    await h.advance(3600);
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.subscribed()).toBe(false);
  });

  it("sends nothing while the page is hidden and checks once when the guest is back", async () => {
    const h = harness();
    h.hide();
    await h.advance(20 + 40 + 80);
    expect(h.check).not.toHaveBeenCalled();
    await h.show();
    expect(h.check).toHaveBeenCalledTimes(1);
    // Back again right away: no second request inside the minimum gap.
    h.hide();
    await h.show();
    expect(h.check).toHaveBeenCalledTimes(1);
    await h.advance(tableOpenRecheckMinimumGapSeconds);
    h.hide();
    await h.show();
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it("'We've been seated' checks now; a stopped watcher sends nothing", async () => {
    const h = harness();
    h.watcher.checkNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.check).toHaveBeenCalledTimes(1);
    // Review (batch 32): the page is told the guest asked, so it asks the entry itself.
    expect(h.check).toHaveBeenLastCalledWith({ manual: true });
    await h.advance(20);
    expect(h.check).toHaveBeenLastCalledWith({ manual: false });
    h.watcher.stop();
    h.watcher.checkNow();
    await h.advance(3600);
    expect(h.check).toHaveBeenCalledTimes(2);
  });
});

// WP-2423 (guest-waits-and-refund-lock, v15 batch 31): staff pressed Open table and the guest's page
// still said "not open" 20 s and 50 s later. With the cheap check it goes on within seconds.
describe("a table not open yet: the cheap check every few seconds, bounded", () => {
  const wait = { delaysSeconds: tableWaitCheckDelaysSeconds, minimumGapSeconds: 3 };
  it("checks every 3 s, backs off to 10 s and 30 s, at most 70 in ten minutes, stops at 15 minutes", async () => {
    const at: number[] = [];
    let total = 0;
    for (const seconds of tableWaitCheckDelaysSeconds) at.push((total += seconds));
    expect(total).toBe(900);
    for (const start of at)
      expect(at.filter((t) => t >= start && t < start + 600).length).toBeLessThanOrEqual(70);
    const h = harness([], wait);
    await h.advance(3);
    expect(h.check).toHaveBeenCalledTimes(1);
    await h.advance(120 - 3);
    expect(h.check).toHaveBeenCalledTimes(40);
    await h.advance(900 - 120);
    expect(h.check).toHaveBeenCalledTimes(tableWaitCheckDelaysSeconds.length);
    expect(h.exhausted).toHaveBeenCalledTimes(1);
    await h.advance(3600);
    expect(h.check).toHaveBeenCalledTimes(tableWaitCheckDelaysSeconds.length);
    expect(h.pending()).toBe(0);
  });

  it("staff open the table: the page goes on at the next check, a few seconds later", async () => {
    const h = harness([true, true, false], wait);
    await h.advance(9);
    expect(h.check).toHaveBeenCalledTimes(3);
    await h.advance(600);
    expect(h.check).toHaveBeenCalledTimes(3);
    expect(h.subscribed()).toBe(false);
    expect(h.exhausted).not.toHaveBeenCalled();
  });

  it("a busy answer's Retry-After is respected, then the checks go on", async () => {
    const h = harness([{ waitSeconds: 30 }], wait);
    await h.advance(3);
    expect(h.check).toHaveBeenCalledTimes(1);
    await h.advance(29);
    expect(h.check).toHaveBeenCalledTimes(1);
    await h.advance(1);
    expect(h.check).toHaveBeenCalledTimes(2);
    await h.advance(3);
    expect(h.check).toHaveBeenCalledTimes(3);
  });

  it("hidden: nothing is sent; back in front it checks at once, not sooner than 3 s apart", async () => {
    const h = harness([], wait);
    h.hide();
    await h.advance(60);
    expect(h.check).not.toHaveBeenCalled();
    await h.show();
    expect(h.check).toHaveBeenCalledTimes(1);
    h.hide();
    await h.show();
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("after it stopped, 'We've been seated' checks now and starts the checks again", async () => {
    const h = harness([], wait);
    await h.advance(900);
    expect(h.exhausted).toHaveBeenCalledTimes(1);
    const before = h.check.mock.calls.length;
    h.watcher.checkNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.check).toHaveBeenCalledTimes(before + 1);
    await h.advance(3);
    expect(h.check).toHaveBeenCalledTimes(before + 2);
  });

  // Batch 33 (v15 b32 live): shown again, checks came at +50 ms and +328 ms (the visible check and
  // the timer that ran while hidden).
  it("back in front after a while hidden: one check, and the next a full step later", async () => {
    const h = harness([], wait);
    await h.advance(3.1);
    expect(h.check).toHaveBeenCalledTimes(1);
    h.hide();
    await h.advance(19.7);
    await h.show();
    expect(h.check).toHaveBeenCalledTimes(2);
    await h.advance(2.9);
    expect(h.check).toHaveBeenCalledTimes(2);
    await h.advance(0.2);
    expect(h.check).toHaveBeenCalledTimes(3);
    expect(h.pending()).toBe(1);
  });

  it("a refused check pauses the checks; 'We've been seated' asks and starts them again", async () => {
    const h = harness([true, "Paused"], wait);
    await h.advance(6);
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.pending()).toBe(0);
    await h.advance(600);
    h.hide();
    await h.show();
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.exhausted).not.toHaveBeenCalled();
    h.watcher.checkNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.check).toHaveBeenCalledTimes(3);
    expect(h.check).toHaveBeenLastCalledWith({ manual: true });
    await h.advance(3);
    expect(h.check).toHaveBeenCalledTimes(4);
  });
});
