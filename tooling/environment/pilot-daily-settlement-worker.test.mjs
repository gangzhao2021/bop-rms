import { afterEach, beforeEach, expect, it, vi } from "vitest";
import process from "node:process";
vi.mock("./pilot-workload-health.mjs", () => ({
  createPilotWorkloadHealthObserver: () => vi.fn(),
}));
import {
  startPilotDailySettlementWorker,
  isRetryableDailySettlementFailure,
  parseDailySettlementWorkerArguments,
} from "./pilot-daily-settlement-worker.mjs";
beforeEach(() => {
  process.exitCode = 0;
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
it.each(["throw", "bad-result"])("closes and reports daily failure for %s", async (mode) => {
  const close = vi.fn(),
    providerClose = vi.fn();
  await startPilotDailySettlementWorker({
    directory: "unused",
    createResources: async () => ({ close }),
    createExecution: async () => ({
      runOnce: async () => {
        if (mode === "throw") throw Error("private");
        return { status: "Created", checkCount: 2 };
      },
      close: providerClose,
    }),
    startRuntime: async ({ workload }) => {
      try {
        await workload.start();
      } finally {
        await workload.stop();
      }
    },
  });
  expect(close).toHaveBeenCalledOnce();
  expect(providerClose).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(1);
});
it("requires an explicit valid installation", () => {
  expect(parseDailySettlementWorkerArguments([".local/pilot-v13"])).toBe(".local/pilot-v13");
  for (const args of [[], ["../bad"], [".local/pilot-v13", "extra"]])
    expect(() => parseDailySettlementWorkerArguments(args)).toThrow();
});

it("only retries explicit dependency messages without invoking error getters", () => {
  expect(
    isRetryableDailySettlementFailure({ code: "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE" }),
  ).toBe(true);
  expect(
    isRetryableDailySettlementFailure({ code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED" }),
  ).toBe(false);
  expect(isRetryableDailySettlementFailure(Error("DAILY_SETTLEMENT_SOURCE_UNAVAILABLE"))).toBe(
    true,
  );
  for (const value of [
    Error("permission denied"),
    Error("DAILY_SETTLEMENT_EXECUTION_RESULT_INVALID"),
    null,
    {
      get message() {
        throw Error("private");
      },
    },
  ])
    expect(isRetryableDailySettlementFailure(value)).toBe(false);
});
