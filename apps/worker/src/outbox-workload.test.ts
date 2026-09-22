import { afterEach, expect, it, vi } from "vitest";
import { createOutboxWorkload } from "./outbox-workload.js";
afterEach(() => {
  vi.useRealTimers();
});
it("runs one cycle at a time and drains once before removing scheduled work", async () => {
  vi.useFakeTimers();
  let release!: (value: number) => void;
  const pending = new Promise<number>((resolve) => {
    release = resolve;
  });
  const runOnce = vi.fn().mockResolvedValueOnce(0).mockReturnValueOnce(pending);
  const stop = vi.fn(async () => "drained" as const);
  const workload = createOutboxWorkload({
    dispatcher: { runOnce, stop },
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await workload.start();
  await vi.advanceTimersByTimeAsync(50);
  expect(runOnce).toHaveBeenCalledTimes(2);
  const stopping = workload.stop();
  expect(workload.stop()).toBe(stopping);
  expect(stop).not.toHaveBeenCalled();
  release(1);
  await stopping;
  await vi.advanceTimersByTimeAsync(100);
  expect(runOnce).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledOnce();
  await expect(workload.completion).resolves.toBe("stopped");
  expect(vi.getTimerCount()).toBe(0);
});
it("reports background failure and schedules no further cycle", async () => {
  vi.useFakeTimers();
  const runOnce = vi
    .fn()
    .mockResolvedValueOnce(0)
    .mockRejectedValueOnce(new Error("secret-canary"));
  const workload = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" },
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await workload.start();
  await vi.advanceTimersByTimeAsync(100);
  await expect(workload.completion).resolves.toBe("failed");
  expect(runOnce).toHaveBeenCalledTimes(2);
  await workload.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it("reports drain timeout instead of claiming a pending cycle stopped", async () => {
  vi.useFakeTimers();
  let release!: (value: number) => void;
  const runOnce = vi
    .fn()
    .mockResolvedValueOnce(0)
    .mockReturnValueOnce(
      new Promise<number>((resolve) => {
        release = resolve;
      }),
    );
  const workload = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" },
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await workload.start();
  await vi.advanceTimersByTimeAsync(10);
  const outcome = expect(workload.stop()).rejects.toThrow("OUTBOX_WORKLOAD_DRAIN_TIMEOUT");
  await vi.advanceTimersByTimeAsync(100);
  await outcome;
  await expect(workload.completion).resolves.toBe("failed");
  release(0);
});

it("observes actual pending and completed cycles without manufacturing progress", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
  let finish!: (value: number) => void;
  const pending = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const runOnce = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockRejectedValueOnce(new Error("private-failure"));
  const workload = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" },
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  const initial = workload.snapshot();
  expect(initial).toEqual({
    state: "idle",
    lastCycleFailure: null,
    cycleInFlight: false,
    completedCycles: 0,
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
  });
  expect(Object.isFrozen(initial)).toBe(true);
  const starting = workload.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(workload.snapshot()).toEqual({
    state: "running",
    lastCycleFailure: null,
    cycleInFlight: true,
    completedCycles: 0,
    lastCycleStartedAt: "2026-09-20T12:00:00.000Z",
    lastCycleCompletedAt: null,
  });
  expect(runOnce).toHaveBeenCalledTimes(1);
  finish(0);
  await starting;
  const completed = workload.snapshot();
  expect(completed.completedCycles).toBe(1);
  expect(completed.lastCycleCompletedAt).toBe("2026-09-20T12:00:01.000Z");
  expect(completed.cycleInFlight).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  await expect(workload.completion).resolves.toBe("failed");
  expect(workload.snapshot().state).toBe("failed");
  expect(workload.snapshot().completedCycles).toBe(1);
  expect(workload.snapshot().lastCycleCompletedAt).toBe(completed.lastCycleCompletedAt);
  expect(JSON.stringify(workload.snapshot())).not.toContain("private");
  expect(initial.state).toBe("idle");
  await workload.stop();
  expect(workload.snapshot().state).toBe("stopped");
  expect(vi.getTimerCount()).toBe(0);
});

it("emits actual progress while observer failures cannot interrupt dispatch", async () => {
  vi.useFakeTimers();
  const snapshots: unknown[] = [];
  const workload = createOutboxWorkload({
    dispatcher: { runOnce: async () => 0, stop: async () => "drained" },
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot);
      throw new Error("observer unavailable");
    },
  });
  await workload.start();
  expect(workload.snapshot().completedCycles).toBe(1);
  expect(snapshots).toEqual([
    expect.objectContaining({ cycleInFlight: true, completedCycles: 0 }),
    expect.objectContaining({ cycleInFlight: false, completedCycles: 1 }),
  ]);
  await workload.stop();
  expect(snapshots.at(-1)).toMatchObject({ state: "stopped" });
  await expect(workload.completion).resolves.toBe("stopped");
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["40001", "SerializationConflict"],
  ["40P01", "Deadlock"],
  ["55P03", "LockUnavailable"],
  ["57014", "QueryCancelled"],
  ["PRIVATE_CANARY", "Unclassified"],
])("retains bounded failure diagnostics after stop for %s", async (code, category) => {
  vi.useFakeTimers();
  const runOnce = vi
    .fn()
    .mockResolvedValueOnce(0)
    .mockRejectedValueOnce(Object.assign(new Error("PRIVATE_CANARY"), { code }));
  const work = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" },
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await work.start();
  await vi.advanceTimersByTimeAsync(10);
  await work.stop();
  expect(work.snapshot()).toMatchObject({
    state: "stopped",
    completedCycles: 1,
    lastCycleFailure: { category },
  });
  expect(JSON.stringify(work.snapshot())).not.toContain("PRIVATE_CANARY");
});

it("retries explicitly allowed dependency failures with backoff, without counting failed cycles", async () => {
  vi.useFakeTimers();
  const runOnce = vi
    .fn()
    .mockRejectedValueOnce(Error("dependency"))
    .mockRejectedValueOnce(Error("dependency"))
    .mockResolvedValue(0);
  const work = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" },
    pollIntervalMs: 100,
    drainDeadlineMs: 1000,
    retry: { maxRetries: 2, shouldRetry: () => true },
  });
  await work.start();
  expect(work.snapshot().completedCycles).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(runOnce).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(199);
  expect(runOnce).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(work.snapshot().completedCycles).toBe(1);
  expect(work.snapshot().lastCycleFailure).not.toBeNull();
  await work.stop();
});
it("exhausts retry allowance and stops scheduling after shutdown", async () => {
  vi.useFakeTimers();
  const runOnce = vi.fn(async () => {
    throw Error("dependency");
  });
  const work = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" },
    pollIntervalMs: 100,
    drainDeadlineMs: 1000,
    retry: { maxRetries: 1, shouldRetry: () => true },
  });
  await work.start();
  await vi.advanceTimersByTimeAsync(100);
  await expect(work.completion).resolves.toBe("failed");
  expect(runOnce).toHaveBeenCalledTimes(2);
  await work.stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(runOnce).toHaveBeenCalledTimes(2);
});
it("does not retry rejected classifications or throwing classifiers", async () => {
  for (const shouldRetry of [
    () => false,
    () => {
      throw Error("classifier");
    },
  ]) {
    const runOnce = vi.fn(async () => {
      throw Error("permission");
    });
    const work = createOutboxWorkload({
      dispatcher: { runOnce, stop: async () => "drained" },
      pollIntervalMs: 100,
      drainDeadlineMs: 1000,
      retry: { maxRetries: 2, shouldRetry },
    });
    await expect(work.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
    expect(runOnce).toHaveBeenCalledOnce();
    await work.stop();
  }
});
