import { afterEach, expect, it, vi } from "vitest";
import { createPaymentCompensationWorkload } from "./payment-compensation-workload.js";
afterEach(() => vi.useRealTimers());
const candidate = (reference: string) => ({ dispositionReference: reference });
it("advances pages after individual failure and repeats scans for late commits", async () => {
  vi.useFakeTimers();
  const discover = vi
    .fn()
    .mockResolvedValueOnce({
      candidates: [candidate("a"), candidate("b")],
      nextAfterDispositionReference: "b",
    })
    .mockResolvedValueOnce({ candidates: [candidate("c")], nextAfterDispositionReference: null })
    .mockResolvedValue({ candidates: [], nextAfterDispositionReference: null });
  const execute = vi.fn(async (value: { dispositionReference: string }) => {
    if (value.dispositionReference === "a") throw Error("private-provider-canary");
  });
  const recordFailure = vi.fn(async () => {
    return undefined;
  });
  const workload = createPaymentCompensationWorkload({
    discover,
    execute,
    recordFailure,
    pageSize: 2,
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await workload.start();
  await vi.advanceTimersByTimeAsync(20);
  expect(execute.mock.calls.map(([value]) => value.dispositionReference)).toEqual(["a", "b", "c"]);
  expect(recordFailure).toHaveBeenCalledExactlyOnceWith(
    candidate("a"),
    "COMPENSATION_EXECUTION_FAILED",
  );
  expect(discover.mock.calls.map(([value]) => value.afterDispositionReference)).toEqual([
    null,
    "b",
    null,
  ]);
  await workload.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it("drains the active execution without starting remaining candidates or overlapping polls", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.fn(() => pending);
  const discover = vi.fn(async () => ({
    candidates: [candidate("a"), candidate("b")],
    nextAfterDispositionReference: null,
  }));
  const workload = createPaymentCompensationWorkload({
    discover,
    execute,
    recordFailure: async () => {
      return undefined;
    },
    pageSize: 2,
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  const starting = workload.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(30);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(discover).toHaveBeenCalledTimes(1);
  const stopped = workload.stop();
  release();
  await starting;
  await stopped;
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(workload.completion).resolves.toBe("stopped");
});
it("fails the workload if durable failure recording fails", async () => {
  const workload = createPaymentCompensationWorkload({
    discover: async () => ({ candidates: [candidate("a")], nextAfterDispositionReference: null }),
    execute: async () => {
      throw Error("execution");
    },
    recordFailure: async () => {
      throw Error("recording");
    },
    pageSize: 1,
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await expect(workload.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  await expect(workload.completion).resolves.toBe("failed");
  await workload.stop();
});
it.each([
  { candidates: [candidate("b"), candidate("a")], nextAfterDispositionReference: null },
  { candidates: [candidate("a"), candidate("a")], nextAfterDispositionReference: null },
  { candidates: [candidate("a")], nextAfterDispositionReference: "other" },
])("rejects corrupt pages before executing any candidate", async (page) => {
  const execute = vi.fn();
  const workload = createPaymentCompensationWorkload({
    discover: async () => page,
    execute,
    recordFailure: async () => {
      return undefined;
    },
    pageSize: 2,
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await expect(workload.start()).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  await workload.stop();
});

it("records projection refresh failure and retries a durable closed case on the next scan", async () => {
  vi.useFakeTimers();
  const item = candidate("a"),
    result = { status: "Closed" };
  const execute = vi.fn(async () => result);
  const afterExecute = vi
    .fn()
    .mockRejectedValueOnce(new Error("private projection failure"))
    .mockResolvedValue(undefined);
  const recordFailure = vi.fn(async () => undefined);
  const workload = createPaymentCompensationWorkload({
    discover: async () => ({ candidates: [item], nextAfterDispositionReference: null }),
    execute,
    afterExecute,
    recordFailure,
    pageSize: 2,
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await workload.start();
  expect(recordFailure).toHaveBeenCalledExactlyOnceWith(item, "COMPENSATION_EXECUTION_FAILED");
  await vi.advanceTimersByTimeAsync(10);
  expect(afterExecute).toHaveBeenCalledTimes(2);
  expect(afterExecute).toHaveBeenLastCalledWith(item, result);
  await workload.stop();
  expect(await workload.completion).toBe("stopped");
  expect(vi.getTimerCount()).toBe(0);
});

it("publishes real lifecycle snapshots without starting on construction", async () => {
  const discover = vi.fn(async () => ({ candidates: [], nextAfterDispositionReference: null })),
    onSnapshot = vi.fn();
  const workload = createPaymentCompensationWorkload({
    discover,
    execute: async () => undefined,
    recordFailure: async () => undefined,
    pageSize: 5,
    pollIntervalMs: 5000,
    drainDeadlineMs: 100,
    onSnapshot,
  });
  expect(discover).not.toHaveBeenCalled();
  expect(workload.snapshot().state).toBe("idle");
  await workload.start();
  expect(onSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ state: "running", completedCycles: 1, cycleInFlight: false }),
  );
  await workload.stop();
  expect(workload.snapshot().state).toBe("stopped");
});
