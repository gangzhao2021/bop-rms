import { afterEach, expect, it, vi } from "vitest";
import {
  createOutboxWorkload,
  supervisedCycleFailures,
  type OutboxWorkloadSnapshot,
} from "./outbox-workload.js";
import { createCompositeWorkerWorkload } from "./composite-workload.js";
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
    consecutiveFailures: 0,
    failingSince: null,
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
    consecutiveFailures: 0,
    failingSince: null,
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

it("records a safe code and the SQLSTATE from a wrapped Postgres error, never free text", async () => {
  vi.useFakeTimers();
  const database = Object.assign(
    new Error("terminating connection due to idle-in-transaction timeout for PRIVATE_CANARY"),
    {
      code: "25P03",
    },
  );
  const runOnce = vi
    .fn()
    .mockRejectedValueOnce(
      new Error("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE", { cause: database }),
    );
  const work = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" },
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await expect(work.start()).rejects.toThrow();
  expect(work.snapshot().lastCycleFailure).toMatchObject({
    category: "Unclassified",
    code: "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE",
    sqlState: "25P03",
  });
  expect(JSON.stringify(work.snapshot())).not.toContain("PRIVATE_CANARY");
  const wrappedDeadlock = createOutboxWorkload({
    dispatcher: {
      runOnce: vi
        .fn()
        .mockRejectedValueOnce(
          Error("WRAPPED", { cause: Object.assign(Error("x"), { code: "40P01" }) }),
        ),
      stop: async () => "drained",
    },
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await expect(wrappedDeadlock.start()).rejects.toThrow();
  expect(wrappedDeadlock.snapshot().lastCycleFailure).toMatchObject({
    category: "Deadlock",
    code: null,
    sqlState: "40P01",
  });
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

// WP-2423 pilot resilience (2026-10-15): v15 business worker restarted 9 times because one
// cycle failure in one workload (TENANT_DATABASE_TRANSACTION_CONFLICT, *_UNAVAILABLE) failed the
// workload, the group and the process.
const conflict = () =>
  Object.assign(Error("tenant database transaction conflicted; it may be retried"), {
    code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
    diagnostic: { sqlState: "55P03", constraint: null, table: null, closed: false },
  });
it("supervised: retries transient failures with capped backoff and never completes failed", async () => {
  vi.useFakeTimers();
  const snapshots: OutboxWorkloadSnapshot[] = [];
  const runOnce = vi.fn(async (): Promise<number> => {
    throw conflict();
  });
  const work = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" },
    pollIntervalMs: 1000,
    drainDeadlineMs: 1000,
    supervision: { maxBackoffMs: 4000 },
    onSnapshot: (value) => snapshots.push(value),
  });
  let settled = false;
  void work.completion.then(() => {
    settled = true;
  });
  await work.start(); // a failing first cycle no longer fails startup
  // Backoff 1 s, 2 s, 4 s, then capped at 4 s.
  for (const [elapsed, calls] of [
    [999, 1],
    [1, 2],
    [2000, 3],
    [4000, 4],
    [4000, 5],
    [4000, 6],
  ] as const) {
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(runOnce).toHaveBeenCalledTimes(calls);
  }
  const last = work.snapshot();
  expect(last.state).toBe("running");
  expect(last.consecutiveFailures).toBe(6);
  expect(last.failingSince).toBe(snapshots.find((s) => s.consecutiveFailures === 1)?.failingSince);
  expect(last.lastCycleFailure).toMatchObject({
    category: "LockUnavailable",
    code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
    sqlState: "55P03",
  });
  expect(settled).toBe(false);
  runOnce.mockResolvedValue(0);
  await vi.advanceTimersByTimeAsync(4000);
  expect(work.snapshot()).toMatchObject({
    state: "running",
    consecutiveFailures: 0,
    failingSince: null,
    completedCycles: 1,
  });
  await work.stop();
  await expect(work.completion).resolves.toBe("stopped");
});
it("supervised: an invariant failure marks attention_required, keeps retrying slowly and clears on success", async () => {
  vi.useFakeTimers();
  const runOnce = vi
    .fn<() => Promise<number>>()
    .mockResolvedValueOnce(0)
    .mockRejectedValueOnce(Error("PAYMENT_WAIT_DISCOVERY_INVALID"))
    .mockRejectedValueOnce(Error("PAYMENT_WAIT_DISCOVERY_INVALID"))
    .mockResolvedValue(0);
  const work = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" },
    pollIntervalMs: 100,
    drainDeadlineMs: 1000,
    supervision: { attentionRetryMs: 10_000 },
  });
  let settled = false;
  void work.completion.then(() => {
    settled = true;
  });
  await work.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(work.snapshot().state).toBe("attention_required");
  expect(work.snapshot().lastCycleFailure?.code).toBe("PAYMENT_WAIT_DISCOVERY_INVALID");
  await vi.advanceTimersByTimeAsync(9_999);
  expect(runOnce).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(runOnce).toHaveBeenCalledTimes(3);
  expect(work.snapshot()).toMatchObject({ state: "attention_required", consecutiveFailures: 2 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(work.snapshot()).toMatchObject({ state: "running", consecutiveFailures: 0 });
  expect(settled).toBe(false);
  await work.stop();
  await expect(work.completion).resolves.toBe("stopped");
});
it("WP-2423 (v15 2026-10-17): a short database stall during a deploy retries quickly and never asks for a person", async () => {
  vi.useFakeTimers();
  const lostAtCommit = Object.assign(Error("tenant database transaction failed"), {
    code: "TENANT_DATABASE_TRANSACTION_FAILED",
    diagnostic: { sqlState: "08006", constraint: null, table: null, closed: false },
  });
  for (const stall of [lostAtCommit, Error("CONSUMER_TEMPORARY_FAILURE")]) {
    const runOnce = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(stall)
      .mockResolvedValue(0);
    const snapshots: OutboxWorkloadSnapshot[] = [];
    const work = createOutboxWorkload({
      dispatcher: { runOnce, stop: async () => "drained" },
      pollIntervalMs: 1000,
      drainDeadlineMs: 1000,
      supervision: {},
      onSnapshot: (value) => snapshots.push(value),
    });
    await work.start();
    await vi.advanceTimersByTimeAsync(1000); // the stalled cycle
    // Retried after one poll interval, not the five-minute attention pace.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(snapshots.some((value) => value.state === "attention_required")).toBe(false);
    expect(work.snapshot()).toMatchObject({ state: "running", consecutiveFailures: 0 });
    await work.stop();
  }
});
it("supervised: a failing sibling never stops the group (one workload's failure is isolated)", async () => {
  vi.useFakeTimers();
  const healthy = vi.fn(async () => 0);
  const broken = vi.fn(async (): Promise<number> => {
    throw Error("PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE");
  });
  const make = (runOnce: () => Promise<number>) =>
    createOutboxWorkload({
      dispatcher: { runOnce, stop: async () => "drained" },
      pollIntervalMs: 1000,
      drainDeadlineMs: 1000,
      supervision: supervisedCycleFailures,
    });
  const group = createCompositeWorkerWorkload([make(healthy), make(broken)]);
  let settled = false;
  void group.completion?.then(() => {
    settled = true;
  });
  await group.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(settled).toBe(false);
  expect(healthy.mock.calls.length).toBeGreaterThan(100);
  expect(broken.mock.calls.length).toBeGreaterThan(3);
  await group.stop();
  await expect(group.completion).resolves.toBe("stopped");
});
it("supervised: mutually exclusive with bounded retry and validates intervals", () => {
  const dispatcher = { runOnce: async () => 0, stop: async () => "drained" as const };
  for (const extra of [
    { retry: { maxRetries: 1, shouldRetry: () => true }, supervision: {} },
    { supervision: { maxBackoffMs: 0 } },
    { supervision: { attentionRetryMs: 3_600_001 } },
    { supervision: { classify: "Transient" as never } },
  ])
    expect(() =>
      createOutboxWorkload({ dispatcher, pollIntervalMs: 10, drainDeadlineMs: 10, ...extra }),
    ).toThrow("OUTBOX_WORKLOAD_CONFIG_INVALID");
});
it("unsupervised workloads keep fail-fast semantics", async () => {
  const work = createOutboxWorkload({
    dispatcher: {
      runOnce: async () => {
        throw conflict();
      },
      stop: async () => "drained",
    },
    pollIntervalMs: 10,
    drainDeadlineMs: 10,
  });
  await expect(work.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  await expect(work.completion).resolves.toBe("failed");
});
