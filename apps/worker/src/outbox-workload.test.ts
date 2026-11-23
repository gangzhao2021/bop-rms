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
it("WP-2423 batch 50: a placed table round reaches the kitchen read within 2 s, not one poll per event", async () => {
  vi.useFakeTimers();
  // The v15 shape (2026-11-22, TM2): placing a pay-later round records OrderCreated v1 and
  // OrderConfirmed v2 on the same Order in one transaction; v2 is claimable only once v1 is
  // published. Delivering v2 creates the kitchen ticket and records KitchenWorkCreated, whose
  // delivery refreshes the kitchen read. Each delivery took about 60 ms there.
  const outbox: { type: string; aggregate: string; version: number }[] = [];
  const deliveredAt = new Map<string, number>();
  const runOnce = vi.fn(async () => {
    const claimable = outbox.filter(
      (event) =>
        !outbox.some(
          (other) => other.aggregate === event.aggregate && other.version < event.version,
        ),
    );
    for (const event of claimable) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      outbox.splice(outbox.indexOf(event), 1);
      deliveredAt.set(event.type, Date.now());
      if (event.type === "OrderConfirmed")
        outbox.push({ type: "KitchenWorkCreated", aggregate: "ticket", version: 1 });
    }
    return claimable.length;
  });
  const workload = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" as const },
    pollIntervalMs: 1000,
    followUp: { delayMs: 0, maxConsecutive: 10 },
    drainDeadlineMs: 1000,
    supervision: supervisedCycleFailures,
  });
  await workload.start();
  await vi.advanceTimersByTimeAsync(10);
  const placedAt = Date.now();
  outbox.push(
    { type: "OrderCreated", aggregate: "order", version: 1 },
    { type: "OrderConfirmed", aggregate: "order", version: 2 },
  );
  await vi.advanceTimersByTimeAsync(5000);
  const kitchenAt = deliveredAt.get("KitchenWorkCreated") ?? Number.POSITIVE_INFINITY;
  const createdAt = deliveredAt.get("OrderCreated") ?? Number.NEGATIVE_INFINITY;
  // Design (Handoff 80.8): Kitchen projection normal ≤2 s. Before, each step waited a full poll
  // after the previous cycle: 3.17 s here, about 3 s on v15.
  expect(kitchenAt - placedAt).toBeLessThan(2000);
  expect(kitchenAt - createdAt).toBeLessThan(200);
  // An idle store still polls once a second.
  const before = runOnce.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(runOnce.mock.calls.length - before).toBe(10);
  await workload.stop();
});
it("WP-2423 batch 50: busy follow-ups are bounded, then the poll interval applies", async () => {
  vi.useFakeTimers();
  const runOnce = vi.fn(async () => 1);
  const workload = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" as const },
    pollIntervalMs: 1000,
    followUp: { delayMs: 0, maxConsecutive: 10 },
    drainDeadlineMs: 1000,
  });
  // Each prompt follow-up is a zero-delay timer (run as 1 ms, as Node does) after the last cycle.
  await workload.start();
  await vi.advanceTimersByTimeAsync(30);
  expect(runOnce).toHaveBeenCalledTimes(11);
  await vi.advanceTimersByTimeAsync(900);
  expect(runOnce).toHaveBeenCalledTimes(11);
  await vi.advanceTimersByTimeAsync(200);
  expect(runOnce).toHaveBeenCalledTimes(22);
  await workload.stop();
  const dispatcher = { runOnce: async () => 0, stop: async () => "drained" as const };
  for (const followUp of [
    { delayMs: 1000, maxConsecutive: 1 },
    { delayMs: -1, maxConsecutive: 1 },
    { delayMs: 0, maxConsecutive: 0 },
    { delayMs: 0, maxConsecutive: 101 },
    { delayMs: 0.5, maxConsecutive: 1 },
  ])
    expect(() =>
      createOutboxWorkload({ dispatcher, pollIntervalMs: 1000, drainDeadlineMs: 10, followUp }),
    ).toThrow("OUTBOX_WORKLOAD_CONFIG_INVALID");
});
it("WP-2423 batch 51: an accepted paid pickup reaches the kitchen read within 2 s, its OrderConfirmed not waiting a poll", async () => {
  vi.useFakeTimers();
  // The v15 shape (2026-11-23, TM2 pickups 56, 57, 62): staff accept (the request commits in about
  // 70 ms); the payment-wait workload's next cycle (1 s poll) resumes the paid wait and records
  // OrderConfirmed; the business events workload (1 s poll, a sibling started just before it)
  // delivers it, which creates the ticket and records KitchenWorkCreated, whose delivery refreshes
  // the kitchen read. Each delivery or resume took about 60 ms there.
  const { createPaymentAcceptanceWaitWorkload } =
    await import("./payment-acceptance-wait-workload.js");
  const outbox: { type: string; recordedAt: number }[] = [];
  const delivered = new Map<string, { recordedAt: number; at: number }>();
  let acceptedAt = Number.POSITIVE_INFINITY;
  let waiting = true;
  const events = createOutboxWorkload({
    dispatcher: {
      runOnce: async () => {
        const claimable = [...outbox];
        for (const event of claimable) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          outbox.splice(outbox.indexOf(event), 1);
          delivered.set(event.type, { recordedAt: event.recordedAt, at: Date.now() });
          if (event.type === "OrderConfirmed")
            outbox.push({ type: "KitchenWorkCreated", recordedAt: Date.now() });
        }
        return claimable.length;
      },
      stop: async () => "drained" as const,
    },
    pollIntervalMs: 1000,
    followUp: { delayMs: 0, maxConsecutive: 10 },
    drainDeadlineMs: 1000,
    supervision: supervisedCycleFailures,
  });
  const paymentWait = createPaymentAcceptanceWaitWorkload({
    discover: async () => (waiting ? ["paid-pickup"] : []),
    // As tooling/environment/pilot-worker.mjs: a resume that settles the wait wakes the events.
    resume: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (Date.now() < acceptedAt) return { status: "AwaitingOrderAcceptance" };
      waiting = false;
      outbox.push({ type: "OrderConfirmed", recordedAt: Date.now() });
      events.wake();
      return { status: "OrderConfirmed" };
    },
    pageSize: 5,
    pollIntervalMs: 1000,
    drainDeadlineMs: 1000,
    supervision: supervisedCycleFailures,
  });
  const group = createCompositeWorkerWorkload([events, paymentWait]);
  const starting = group.start();
  // Staff accept just after a payment-wait cycle, the slowest case seen live (about 1 s).
  await vi.advanceTimersByTimeAsync(1130);
  await starting;
  acceptedAt = Date.now();
  await vi.advanceTimersByTimeAsync(5000);
  const never = { recordedAt: 0, at: Number.POSITIVE_INFINITY };
  const confirmed = delivered.get("OrderConfirmed") ?? never;
  const kitchen = delivered.get("KitchenWorkCreated") ?? never;
  // Design (Handoff 80.8): Kitchen/Pickup projection normal ≤2 s. Before, OrderConfirmed waited
  // for the next events poll after being recorded: 0.88 s here (1.0-1.35 s on v15, with slower
  // cycles), and the whole path took 1.99 s here (2.12-2.35 s on v15); now 0.06 s and 1.17 s.
  expect(confirmed.at - confirmed.recordedAt).toBeLessThan(200);
  expect(kitchen.at - acceptedAt).toBeLessThan(2000);
  // An idle Store still polls once a second; nothing committed wakes nothing.
  const before = delivered.size;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(delivered.size).toBe(before);
  await group.stop();
});
it("WP-2423 batch 51: a wake cuts only the ordinary poll short, once, and never a failure backoff", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let block = false;
  const runOnce = vi.fn(async () => {
    if (block) await new Promise<void>((resolve) => (release = resolve));
    return 0;
  });
  const workload = createOutboxWorkload({
    dispatcher: { runOnce, stop: async () => "drained" as const },
    pollIntervalMs: 1000,
    drainDeadlineMs: 1000,
  });
  workload.wake(); // Not started: nothing happens.
  await workload.start();
  expect(runOnce).toHaveBeenCalledTimes(1);
  // Waiting for the poll: one cycle at once; repeated wakes coalesce into it.
  workload.wake();
  workload.wake();
  await vi.advanceTimersByTimeAsync(5);
  expect(runOnce).toHaveBeenCalledTimes(2);
  // The poll interval then applies again.
  await vi.advanceTimersByTimeAsync(900);
  expect(runOnce).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(200);
  expect(runOnce).toHaveBeenCalledTimes(3);
  // During a cycle (it may have read before the commit): exactly one more cycle follows at once.
  block = true;
  await vi.advanceTimersByTimeAsync(1000);
  expect(runOnce).toHaveBeenCalledTimes(4);
  block = false;
  workload.wake();
  workload.wake();
  release();
  await vi.advanceTimersByTimeAsync(5);
  expect(runOnce).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(900);
  expect(runOnce).toHaveBeenCalledTimes(5);
  await workload.stop();
  workload.wake();
  await vi.advanceTimersByTimeAsync(5000);
  expect(runOnce).toHaveBeenCalledTimes(5);
  // A supervised failure's backoff is never cut short.
  const failing = vi.fn().mockResolvedValueOnce(0).mockRejectedValue(new Error("x"));
  const supervised = createOutboxWorkload({
    dispatcher: { runOnce: failing, stop: async () => "drained" as const },
    pollIntervalMs: 1000,
    drainDeadlineMs: 1000,
    supervision: { classify: () => "Transient" },
  });
  await supervised.start();
  await vi.advanceTimersByTimeAsync(1005);
  expect(failing).toHaveBeenCalledTimes(2);
  supervised.wake();
  await vi.advanceTimersByTimeAsync(500);
  expect(failing).toHaveBeenCalledTimes(2);
  await supervised.stop();
});
