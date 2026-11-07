import { afterEach, describe, expect, it, vi } from "vitest";
import { createAbuseCleanupWorkload } from "./abuse-cleanup-workload.js";
afterEach(() => vi.useRealTimers());
describe("abuse expiry workload", () => {
  it("runs actual cleanup once at start, polls without overlap and closes once", async () => {
    vi.useFakeTimers();
    let finish: (count: number) => void = () => {
      throw new Error("not started");
    };
    const cleanup = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const close = vi.fn(async () => undefined);
    const workload = createAbuseCleanupWorkload({
      cleanup,
      close,
      pollIntervalMs: 100,
      drainDeadlineMs: 1000,
    });
    const start = workload.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(cleanup).toHaveBeenCalledTimes(1);
    finish(2);
    await start;
    await vi.advanceTimersByTimeAsync(100);
    expect(cleanup).toHaveBeenCalledTimes(2);
    const stop = workload.stop();
    expect(close).not.toHaveBeenCalled();
    finish(0);
    await stop;
    await workload.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(await workload.completion).toBe("stopped");
    await vi.advanceTimersByTimeAsync(500);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it.each([-1, NaN, 0.5])("fails on invalid cleanup result %s", async (count) => {
    const close = vi.fn(async () => undefined);
    const workload = createAbuseCleanupWorkload({
      cleanup: async () => count,
      close,
      pollIntervalMs: 100,
      drainDeadlineMs: 1000,
    });
    await expect(workload.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
    expect(await workload.completion).toBe("failed");
    await workload.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("propagates dependency failure without exposing private details", async () => {
    const workload = createAbuseCleanupWorkload({
      cleanup: async () => {
        throw new Error("private database detail");
      },
      close: async () => undefined,
      pollIntervalMs: 100,
      drainDeadlineMs: 1000,
    });
    await expect(workload.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
    await workload.stop();
  });
});
