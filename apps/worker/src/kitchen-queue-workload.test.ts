import { afterEach, expect, it, vi } from "vitest";
import { createKitchenQueueWorkload } from "./kitchen-queue-workload.js";
afterEach(() => vi.useRealTimers());
it("runs actual refresh without overlap, waits for in-flight work and closes once", async () => {
  vi.useFakeTimers();
  let finish!: (value: 0 | 1) => void;
  const refresh = vi.fn(
    () =>
      new Promise<0 | 1>((resolve) => {
        finish = resolve;
      }),
  );
  const close = vi.fn(async () => undefined);
  const workload = createKitchenQueueWorkload({
    refresh,
    close,
    pollIntervalMs: 100,
    drainDeadlineMs: 1000,
  });
  const starting = workload.start();
  await vi.advanceTimersByTimeAsync(500);
  expect(refresh).toHaveBeenCalledTimes(1);
  finish(1);
  await starting;
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(2);
  const stopping = workload.stop();
  expect(close).not.toHaveBeenCalled();
  finish(0);
  await stopping;
  await workload.stop();
  expect(close).toHaveBeenCalledTimes(1);
  expect(await workload.completion).toBe("stopped");
  await vi.advanceTimersByTimeAsync(500);
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("propagates failure without private details and drains resources", async () => {
  const close = vi.fn(async () => undefined);
  const workload = createKitchenQueueWorkload({
    refresh: async () => {
      throw new Error("private SQL");
    },
    close,
    pollIntervalMs: 100,
    drainDeadlineMs: 1000,
  });
  await expect(workload.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  expect(await workload.completion).toBe("failed");
  await workload.stop();
  expect(close).toHaveBeenCalledTimes(1);
});
it("rejects invalid owner refresh results", async () => {
  const workload = createKitchenQueueWorkload({
    refresh: async () => 2 as 1,
    close: async () => undefined,
    pollIntervalMs: 100,
    drainDeadlineMs: 1000,
  });
  await expect(workload.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  await workload.stop();
});
