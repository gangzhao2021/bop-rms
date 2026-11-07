import { afterEach, expect, it, vi } from "vitest";
import console from "node:console";
import process from "node:process";
const health = vi.hoisted(() => ({ snapshots: [] }));
vi.mock("./pilot-workload-health.mjs", () => ({
  createPilotWorkloadHealthObserver: (_directory, component) => (snapshot) =>
    health.snapshots.push({ component, ...snapshot }),
}));
// WP-2423 v15: a failed cycle is reported in health and retried; the worker keeps running.
const cycleFailed = () =>
  health.snapshots.some(
    (snapshot) =>
      snapshot.component === "dining-exception-worker" && snapshot.lastCycleFailure !== null,
  );
const of = (component) => health.snapshots.filter((snapshot) => snapshot.component === component);
import {
  createMemberPointsWorkload,
  startPilotDiningExceptionWorker,
  parseDiningExceptionWorkerArguments,
} from "./pilot-dining-exception-worker.mjs";
afterEach(() => {
  process.exitCode = 0;
  health.snapshots.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("constructs without scanning and runs only projection recovery with graceful resource cleanup", async () => {
  const recover = vi.fn(async () => ({ projectedCount: 0, scanComplete: true })),
    close = vi.fn(async () => undefined);
  await startPilotDiningExceptionWorker({
    directory: "unused",
    createResources: async () => ({ close }),
    createRecovery: () => recover,
    startRuntime: async ({ workload }) => {
      expect(recover).not.toHaveBeenCalled();
      await workload.start();
      expect(recover).toHaveBeenCalledOnce();
      await workload.stop();
      await workload.stop();
      expect(await workload.completion).toBe("stopped");
    },
  });
  expect(close).toHaveBeenCalledOnce();
});
it("keeps running, reports the failed cycle and closes resources when owner scan fails", async () => {
  const close = vi.fn(async () => undefined),
    recover = vi.fn(async () => {
      throw Error("owner unavailable");
    });
  await startPilotDiningExceptionWorker({
    directory: "unused",
    createResources: async () => ({ close }),
    createRecovery: () => recover,
    startRuntime: async ({ workload }) => {
      try {
        await workload.start();
      } finally {
        await workload.stop();
      }
    },
  });
  expect(process.exitCode).toBe(0);
  expect(cycleFailed()).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});
it("rejects malformed recovery progress", async () => {
  const close = vi.fn(async () => undefined);
  await startPilotDiningExceptionWorker({
    directory: "unused",
    createResources: async () => ({ close }),
    createRecovery: () => async () => ({ projectedCount: 6, scanComplete: true }),
    startRuntime: async ({ workload }) => {
      try {
        await workload.start();
      } finally {
        await workload.stop();
      }
    },
  });
  expect(process.exitCode).toBe(0);
  expect(cycleFailed()).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

it("requires one explicit bounded installation directory", () => {
  expect(parseDiningExceptionWorkerArguments([".local/other-pilot"])).toBe(".local/other-pilot");
  for (const args of [
    [],
    [undefined],
    ["/tmp/other"],
    [".local/../other"],
    [".local/pilot-v12", "extra"],
  ])
    expect(() => parseDiningExceptionWorkerArguments(args)).toThrow();
});

// WP-2423 取舍 18, v15 2026-11-06 (points-sweep): each Store's own worker settles points for its
// directory as its own supervised workload: a failure shows in that workload's health and is retried,
// and never stops the recovery beside it.
const ledgerDisagrees = () =>
  Object.assign(new Error("STORE_SALES_PAYMENT_LEDGER_UNAVAILABLE"), {
    rule: "OnlineCapturesDisagree",
  });
it("gives the runtime one workload whose start and stop drive the recovery and the points sweep", async () => {
  const settlePoints = vi.fn().mockResolvedValue(0);
  const expirePoints = vi.fn().mockResolvedValue({ notified: 0, expired: 0 });
  const createMemberSweep = vi.fn(async () => ({ settlePoints, expirePoints }));
  const recover = vi.fn(async () => ({ projectedCount: 0, scanComplete: true }));
  const resources = { close: vi.fn(async () => undefined), publicProfile: { binding: {} } };
  await startPilotDiningExceptionWorker({
    directory: "/app/.local/pilot-v15/stores/demo-2",
    providerAccountReference: "provider",
    createResources: async () => resources,
    createRecovery: () => recover,
    createMemberSweep,
    // As the Stores' shared process (pilot-store-workers.mjs) runs it: `workload` only.
    startRuntime: async (options) => {
      expect(options.workloads).toBeUndefined();
      // The points workload's health exists before its first cycle.
      expect(of("dining-exception-member-points")).toHaveLength(1);
      expect(of("dining-exception-member-points")[0].state).toBe("idle");
      await options.workload.start();
      expect(recover).toHaveBeenCalledOnce();
      expect(settlePoints).toHaveBeenCalledOnce();
      expect(expirePoints).toHaveBeenCalledOnce();
      await options.workload.stop();
      await options.workload.stop();
      expect(await options.workload.completion).toBe("stopped");
    },
  });
  expect(createMemberSweep).toHaveBeenCalledWith({
    directory: "/app/.local/pilot-v15/stores/demo-2",
    resources,
    providerAccountReference: "provider",
  });
  expect(resources.close).toHaveBeenCalledOnce();
  expect(of("dining-exception-member-points").at(-1).state).toBe("stopped");
  expect(process.exitCode).toBe(0);
});
it("a ledger that disagrees needs a person at once, names its Store and rule, and clears on success", async () => {
  vi.useFakeTimers();
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const settlePoints = vi.fn().mockRejectedValueOnce(ledgerDisagrees()).mockResolvedValue(2);
  const expirePoints = vi.fn().mockResolvedValue({ notified: 0, expired: 0 });
  const recover = vi.fn(async () => ({ projectedCount: 0, scanComplete: true }));
  const resources = { close: vi.fn(async () => undefined), publicProfile: { binding: {} } };
  let workload;
  await startPilotDiningExceptionWorker({
    directory: "/app/.local/pilot-v15/stores/demo-2",
    providerAccountReference: "provider",
    createResources: async () => resources,
    createRecovery: () => recover,
    createMemberSweep: async () => ({ settlePoints, expirePoints }),
    startRuntime: async (options) => {
      workload = options.workload;
    },
  });
  await workload.start();
  const failed = of("dining-exception-member-points").at(-1);
  expect(failed).toMatchObject({ state: "attention_required", consecutiveFailures: 1 });
  expect(failed.lastCycleFailure.code).toBe("MEMBER_POINTS_LEDGER_MISMATCH");
  expect(expirePoints).not.toHaveBeenCalled();
  // The recovery beside it carries on, healthy.
  expect(of("dining-exception-worker").at(-1)).toMatchObject({
    state: "running",
    consecutiveFailures: 0,
  });
  const line = report.mock.calls
    .map(([text]) => String(text))
    .find((text) => text.includes("MEMBER_POINTS_SWEEP_UNAVAILABLE"));
  expect(JSON.parse(line)).toMatchObject({
    event: "MEMBER_POINTS_SWEEP_UNAVAILABLE",
    code: "STORE_SALES_PAYMENT_LEDGER_UNAVAILABLE",
    rule: "OnlineCapturesDisagree",
    store: "stores/demo-2",
  });
  expect(line).not.toMatch(/\+1|613|provider/u);
  // Retried every five minutes while a person is needed; a success clears it.
  await vi.advanceTimersByTimeAsync(299_000);
  expect(settlePoints).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(settlePoints).toHaveBeenCalledTimes(2);
  expect(of("dining-exception-member-points").at(-1)).toMatchObject({
    state: "running",
    consecutiveFailures: 0,
    failingSince: null,
  });
  // Then once every five minutes, though it polls every minute.
  await vi.advanceTimersByTimeAsync(240_000);
  expect(settlePoints).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settlePoints).toHaveBeenCalledTimes(3);
  await workload.stop();
  expect(resources.close).toHaveBeenCalledOnce();
});
it("a lost database connection is retried every minute and raised only once it lasts two minutes", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { parsePilotWorkloadHealth } = await vi.importActual("./pilot-workload-health.mjs");
  const read = (snapshot) =>
    parsePilotWorkloadHealth(
      { pid: 1, started: "1", observedAt: new Date().toISOString(), snapshot },
      { pid: 1, started: "1" },
    );
  const snapshots = [];
  const settlePoints = vi.fn().mockRejectedValue(new Error("TENANT_DATABASE_ACQUIRE_FAILED"));
  const loop = createMemberPointsWorkload({
    directory: "/app/.local/pilot-v15",
    resources: { publicProfile: { binding: {} } },
    providerAccountReference: "provider",
    createMemberSweep: async () => ({ settlePoints, expirePoints: vi.fn() }),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  await loop.start();
  const first = snapshots.at(-1);
  expect(first).toMatchObject({ state: "running", consecutiveFailures: 1 });
  expect(read(first).attention).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settlePoints).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settlePoints).toHaveBeenCalledTimes(3);
  const persisting = snapshots.at(-1);
  // Never attention_required for the state, but raised by the two-minute rule.
  expect(snapshots.every((snapshot) => snapshot.state !== "attention_required")).toBe(true);
  expect(persisting.consecutiveFailures).toBe(3);
  expect(read(persisting).attention).toBe(true);
  await loop.stop();
});
it("without the Store's public profile the points workload still reports, healthy and idle of work", async () => {
  vi.useFakeTimers();
  const snapshots = [];
  const createMemberSweep = vi.fn();
  const loop = createMemberPointsWorkload({
    directory: "/app/.local/pilot-v15",
    resources: {},
    providerAccountReference: "provider",
    createMemberSweep,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  expect(snapshots).toHaveLength(1);
  await loop.start();
  expect(snapshots.at(-1)).toMatchObject({
    state: "running",
    completedCycles: 1,
    consecutiveFailures: 0,
  });
  expect(createMemberSweep).not.toHaveBeenCalled();
  await loop.stop();
});
