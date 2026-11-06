import { afterEach, expect, it, vi } from "vitest";
import { createPaymentAcceptanceWaitWorkload } from "./payment-acceptance-wait-workload.js";
import { supervisedCycleFailures } from "./outbox-workload.js";
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

// WP-2423 M04: one stuck paid round stopped every later paid order of the Store reaching the
// kitchen (the worker resumed the oldest wait first, failed, and started again from it).
it("resumes the rest of the page when one wait fails, and retries that one after a backoff", async () => {
  vi.useFakeTimers();
  const healthy = new Set(["b", "c", "d", "e"]);
  let broken = true;
  const resume = vi.fn(async (event: string) => {
    if (event === "a" && broken) throw Object.assign(new Error("private"), { code: "X" });
    return { status: healthy.has(event) ? "Released" : "Released" };
  });
  const failures: unknown[] = [];
  const work = createPaymentAcceptanceWaitWorkload({
    pageSize: 5,
    pollIntervalMs: 1000,
    drainDeadlineMs: 100,
    discover: async (_limit, after) => (after === null ? ["a", "b", "c", "d", "e"] : []),
    resume,
    supervision: supervisedCycleFailures,
    onWaitFailure: (failure) => failures.push(failure),
  });
  await work.start();
  await vi.advanceTimersByTimeAsync(0);
  const calls = (event: string) => resume.mock.calls.filter(([value]) => value === event).length;
  // The same cycle resumed b to e although a failed first.
  expect(resume.mock.calls.slice(0, 5).map(([value]) => value)).toEqual(["a", "b", "c", "d", "e"]);
  expect(work.stuckCount()).toBe(1);
  expect(failures).toEqual([expect.objectContaining({ failures: 1, stuckWaits: 1 })]);
  expect(JSON.stringify(failures)).not.toContain('"a"');
  // Not retried on every poll: the next polls (1 s apart) skip it until its 5 s backoff.
  await vi.advanceTimersByTimeAsync(4000);
  expect(calls("a")).toBe(1);
  expect(calls("b")).toBeGreaterThan(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(calls("a")).toBe(2);
  // Backoff doubles but never passes 30 s: a wait staff since accepted is retried promptly.
  await vi.advanceTimersByTimeAsync(120_000);
  const before = calls("a");
  broken = false;
  await vi.advanceTimersByTimeAsync(31_000);
  expect(calls("a")).toBe(before + 1);
  expect(work.stuckCount()).toBe(0);
  await work.stop();
});
it("forgets a failing wait once discovery no longer finds it (settled elsewhere)", async () => {
  vi.useFakeTimers();
  let events = ["a", "b"];
  const work = createPaymentAcceptanceWaitWorkload({
    ...config,
    pageSize: 5,
    discover: async () => events,
    resume: async (event: string) => {
      if (event === "a") throw new Error("private");
    },
    supervision: supervisedCycleFailures,
  });
  await work.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(work.stuckCount()).toBe(1);
  // Staff rejected and refunded it: it leaves the durable queue.
  events = ["b"];
  await vi.advanceTimersByTimeAsync(50);
  expect(work.stuckCount()).toBe(0);
  await work.stop();
});
it("unsupervised, still resumes the page's other waits before failing", async () => {
  vi.useFakeTimers();
  const resume = vi.fn(async (event: string) => {
    if (event === "a") throw new Error("private details");
  });
  const work = createPaymentAcceptanceWaitWorkload({
    ...config,
    pageSize: 3,
    discover: async () => ["a", "b", "c"],
    resume,
  });
  await expect(work.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  expect(resume.mock.calls.map(([value]) => value)).toEqual(["a", "b", "c"]);
  await work.stop();
});
