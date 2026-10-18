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
it("WP-2423 (v15 2026-10-18): names a source invariant breach and keeps a database SQLSTATE", async () => {
  vi.useFakeTimers();
  // The owner error shape the Kitchen source reader throws (public code unchanged).
  const owner = (cause: unknown) =>
    Object.assign(Error("kitchen queue is unavailable", { cause }), {
      code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
    });
  const mismatch = owner(Error("KITCHEN_QUEUE_SOURCE_MISMATCH", { cause: Error("row 9 != 12") }));
  const deadlock = owner(Object.assign(Error("deadlock detected"), { code: "40P01" }));
  for (const [error, expected, state] of [
    [
      mismatch,
      { category: "Unclassified", code: "KITCHEN_QUEUE_SOURCE_MISMATCH", sqlState: null },
      "attention_required",
    ],
    [
      deadlock,
      { category: "Deadlock", code: "KITCHEN_QUEUE_REFRESH_UNAVAILABLE", sqlState: "40P01" },
      "running",
    ],
  ] as const) {
    const workload = createKitchenQueueWorkload({
      refresh: async () => {
        throw error;
      },
      close: async () => undefined,
      pollIntervalMs: 100,
      drainDeadlineMs: 1000,
      supervision: {},
    });
    await workload.start();
    await vi.advanceTimersByTimeAsync(50);
    const snapshot = workload.snapshot();
    expect(snapshot.lastCycleFailure).toMatchObject(expected);
    expect(snapshot.state).toBe(state);
    expect(JSON.stringify(snapshot)).not.toContain("row 9");
    await workload.stop();
  }
});
