import { afterEach, expect, it, vi } from "vitest";
import { createPaymentAcceptanceWaitWorkload } from "./payment-acceptance-wait-workload.js";
afterEach(() => vi.useRealTimers());
const config = { pageSize: 2, pollIntervalMs: 10, drainDeadlineMs: 100 };
it("pages beyond still-waiting records and wraps to re-evaluate earlier work", async () => {
  vi.useFakeTimers();
  const discover = vi.fn(async (_limit: number, after: string | null) =>
    after === null ? ["a", "b"] : ["c"],
  );
  const resume = vi.fn(async () => ({ status: "AwaitingOrderAcceptance" }));
  const work = createPaymentAcceptanceWaitWorkload({ ...config, discover, resume });
  await work.start();
  await vi.advanceTimersByTimeAsync(20);
  await work.stop();
  expect(discover.mock.calls).toEqual([
    [2, null],
    [2, "b"],
    [2, null],
  ]);
  expect(resume.mock.calls).toHaveLength(5);
  expect(vi.getTimerCount()).toBe(0);
});
it("fails once on resume error and leaves retry to explicit repair/restart", async () => {
  vi.useFakeTimers();
  const resume = vi.fn().mockRejectedValue(new Error("private details"));
  const work = createPaymentAcceptanceWaitWorkload({
    ...config,
    discover: async () => ["a"],
    resume,
  });
  await expect(work.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  await expect(work.completion).resolves.toBe("failed");
  await vi.advanceTimersByTimeAsync(1000);
  expect(resume).toHaveBeenCalledTimes(1);
  await work.stop();
});
it("drains current resume and does not overlap or start the rest of the page", async () => {
  vi.useFakeTimers();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resume = vi.fn(() => held);
  const work = createPaymentAcceptanceWaitWorkload({
    ...config,
    discover: async () => ["a", "b"],
    resume,
  });
  const starting = work.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(resume).toHaveBeenCalledTimes(1);
  const stopping = work.stop();
  release();
  await starting;
  await stopping;
  expect(resume).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  ["b", "a"],
  ["a", "a"],
  ["a", "b", "c"],
])("refuses invalid discovery before resuming: %j", async (...events) => {
  const resume = vi.fn();
  const work = createPaymentAcceptanceWaitWorkload({
    ...config,
    discover: async () => events,
    resume,
  });
  await expect(work.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  expect(resume).not.toHaveBeenCalled();
  await work.stop();
});

it("publishes real wait-cycle progress without exposing event references", async () => {
  vi.useFakeTimers();
  const snapshots: unknown[] = [];
  const work = createPaymentAcceptanceWaitWorkload({
    ...config,
    discover: async () => ["private-event"],
    resume: async () => undefined,
    onSnapshot: (value) => snapshots.push(value),
  });
  await work.start();
  await work.stop();
  expect(snapshots).toContainEqual(
    expect.objectContaining({ cycleInFlight: true, completedCycles: 0 }),
  );
  expect(snapshots).toContainEqual(
    expect.objectContaining({ cycleInFlight: false, completedCycles: 1 }),
  );
  expect(JSON.stringify(snapshots)).not.toContain("private-event");
  expect(vi.getTimerCount()).toBe(0);
});
