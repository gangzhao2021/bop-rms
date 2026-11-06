import { describe, expect, it, vi } from "vitest";
import {
  startTableCartPoll,
  tableCartPollDelay,
  tableCartPollIntervalMs,
  tableCartPollMaxDelayMs,
} from "./table-cart-poll.js";

const flush = async () => {
  for (let n = 0; n < 6; n += 1) await Promise.resolve();
};

function harness(options: { ok?: () => boolean } = {}) {
  const timers: { callback: () => void; ms: number; handle: number }[] = [];
  let handles = 0;
  const state = { visible: true, online: true, allowed: true };
  const read = vi.fn(async () => (options.ok ?? (() => true))());
  const poll = startTableCartPoll({
    read,
    shouldRead: () => state.allowed,
    visible: () => state.visible,
    online: () => state.online,
    setTimer: (callback, ms) => {
      handles += 1;
      timers.push({ callback, ms, handle: handles });
      return handles;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const fire = async () => {
    const next = timers.shift();
    if (next === undefined) throw new Error("no timer pending");
    next.callback();
    await flush();
    return next.ms;
  };
  return { timers, state, read, poll, fire };
}

describe("WP-2423 same-table-ordering: the table cart keeps up with the other phones", () => {
  it("reads every 4 seconds while on screen and online", async () => {
    const h = harness();
    expect(tableCartPollIntervalMs).toBe(4_000);
    expect(await h.fire()).toBe(4_000);
    expect(await h.fire()).toBe(4_000);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.timers.map((timer) => timer.ms)).toEqual([4_000]);
  });

  it("reads nothing while hidden or offline, and reads at once when back", async () => {
    const h = harness();
    h.state.visible = false;
    await h.fire();
    expect(h.read).not.toHaveBeenCalled();
    // No timer keeps ticking in the background.
    expect(h.timers).toEqual([]);
    h.state.visible = true;
    h.poll.wake();
    await flush();
    expect(h.read).toHaveBeenCalledTimes(1);
    h.state.online = false;
    await h.fire();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.timers).toEqual([]);
  });

  it("waits while a change or a round is on its way, without reading", async () => {
    const h = harness();
    h.state.allowed = false;
    await h.fire();
    await h.fire();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.timers.map((timer) => timer.ms)).toEqual([4_000]);
  });

  it("after a failed read waits twice as long each time, up to a minute, and resets on success", async () => {
    let ok = false;
    const h = harness({ ok: () => ok });
    const waits: number[] = [];
    for (let n = 0; n < 6; n += 1) {
      await h.fire();
      waits.push(h.timers[0]?.ms ?? 0);
    }
    expect(waits).toEqual([8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    // Coming back to the page after failures keeps the wait (no burst of reads).
    h.poll.wake();
    expect(h.read).toHaveBeenCalledTimes(6);
    ok = true;
    await h.fire();
    expect(h.timers[0]?.ms).toBe(4_000);
    expect(tableCartPollDelay(0)).toBe(4_000);
    expect(tableCartPollDelay(99)).toBe(tableCartPollMaxDelayMs);
  });

  it("stops for good", async () => {
    const h = harness();
    h.poll.stop();
    expect(h.timers).toEqual([]);
    h.poll.wake();
    expect(h.read).not.toHaveBeenCalled();
  });
});
