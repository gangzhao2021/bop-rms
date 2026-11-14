import { afterEach, beforeEach, expect, it, vi } from "vitest";
import process from "node:process";
const health = vi.hoisted(() => ({ snapshots: [] }));
vi.mock("./pilot-workload-health.mjs", () => ({
  createPilotWorkloadHealthObserver: () => (snapshot) => health.snapshots.push(snapshot),
}));
import {
  startPilotDailySettlementWorker,
  parseDailySettlementWorkerArguments,
} from "./pilot-daily-settlement-worker.mjs";
beforeEach(() => {
  process.exitCode = 0;
  health.snapshots.length = 0;
});
afterEach(() => {
  process.exitCode = 0;
});
it("runs an isolated daily cycle and drains before closing both resources once", async () => {
  const close = vi.fn(),
    providerClose = vi.fn(),
    runOnce = vi.fn(async () => ({ status: "Duplicate", checkCount: 1 }));
  await startPilotDailySettlementWorker({
    directory: "unused",
    createResources: async () => ({ close }),
    createExecution: async () => ({ runOnce, close: providerClose }),
    startRuntime: async ({ workload }) => {
      expect(runOnce).not.toHaveBeenCalled();
      await workload.start();
      await workload.stop();
      await workload.stop();
      expect(await workload.completion).toBe("stopped");
    },
  });
  expect(runOnce).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(providerClose).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(0);
});
// WP-2423 v15: a failing cycle (a data-shape error included) never stops the worker; it is
// reported (health and alert) and retried while the process keeps running.
it.each(["throw", "bad-result"])(
  "keeps running and reports a daily failure for %s",
  async (mode) => {
    const close = vi.fn(),
      providerClose = vi.fn();
    await startPilotDailySettlementWorker({
      directory: "unused",
      createResources: async () => ({ close }),
      createExecution: async () => ({
        runOnce: async () => {
          if (mode === "throw") throw Error("STORE_BUSINESS_DATE_UNAVAILABLE");
          return { status: "Created", checkCount: 2 };
        },
        close: providerClose,
      }),
      startRuntime: async ({ workload }) => {
        await workload.start();
        const snapshot = health.snapshots.at(-1);
        expect(snapshot.state === "running" || snapshot.state === "attention_required").toBe(true);
        expect(snapshot.consecutiveFailures).toBe(1);
        expect(snapshot.lastCycleFailure.code).toBe(
          mode === "throw"
            ? "STORE_BUSINESS_DATE_UNAVAILABLE"
            : "DAILY_SETTLEMENT_EXECUTION_RESULT_INVALID",
        );
        await workload.stop();
        expect(await workload.completion).toBe("stopped");
      },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(providerClose).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  },
);
it("reports a day that still fails after other days progressed", async () => {
  const close = vi.fn(),
    dayFailure = Error("STORE_BUSINESS_DATE_UNAVAILABLE");
  await startPilotDailySettlementWorker({
    directory: "unused",
    createResources: async () => ({ close }),
    createExecution: async () => ({
      runOnce: async () => ({ status: "Created", checkCount: 1, failure: dayFailure }),
      close: vi.fn(),
    }),
    startRuntime: async ({ workload }) => {
      await workload.start();
      expect(health.snapshots.at(-1).lastCycleFailure.code).toBe("STORE_BUSINESS_DATE_UNAVAILABLE");
      await workload.stop();
    },
  });
  expect(process.exitCode).toBe(0);
});
it("reports a failed start when resources cannot be created into an execution", async () => {
  const close = vi.fn();
  await startPilotDailySettlementWorker({
    directory: "unused",
    createResources: async () => ({ close }),
    createExecution: async () => {
      throw Error("private");
    },
    startRuntime: async () => undefined,
  });
  expect(close).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(1);
});
it("requires an explicit valid installation", () => {
  expect(parseDailySettlementWorkerArguments([".local/pilot-v13"])).toBe(".local/pilot-v13");
  for (const args of [[], ["../bad"], [".local/pilot-v13", "extra"]])
    expect(() => parseDailySettlementWorkerArguments(args)).toThrow();
});
