import { describe, expect, it, vi } from "vitest";
import {
  tableOpenRecheckDelaysSeconds,
  tableOpenRecheckMinimumGapSeconds,
  watchTableOpening,
} from "./table-open-recheck.js";

function harness(results: boolean[] = []) {
  let now = 0;
  let visible = true;
  const timers: { at: number; callback: () => void }[] = [];
  let listener: (() => void) | null = null;
  const check = vi.fn(async () => results.shift() ?? true);
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
    h.watcher.stop();
    h.watcher.checkNow();
    await h.advance(3600);
    expect(h.check).toHaveBeenCalledTimes(1);
  });
});
