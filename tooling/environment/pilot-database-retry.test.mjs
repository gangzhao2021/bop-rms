import { afterEach, expect, it, vi } from "vitest";
import process from "node:process";
vi.mock("./pilot-workload-health.mjs", () => ({
  createPilotWorkloadHealthObserver: () => vi.fn(),
}));
import { isRetryablePilotDatabaseAcquisition } from "./pilot-database-retry.mjs";
import { startPilotReconciliationWorker } from "./pilot-reconciliation-worker.mjs";
import { startPilotDiningExceptionWorker } from "./pilot-dining-exception-worker.mjs";
afterEach(() => {
  vi.useRealTimers();
  process.exitCode = 0;
});
const unavailable = () =>
  Object.assign(Error("redacted"), { code: "TENANT_DATABASE_ACQUIRE_FAILED" });
it("accepts only the acquisition code without invoking accessors", () => {
  expect(isRetryablePilotDatabaseAcquisition(unavailable())).toBe(true);
  for (const error of [
    null,
    Error("tenant database connection is unavailable"),
    { code: "TENANT_DATABASE_TRANSACTION_FAILED" },
    { code: "TENANT_DATABASE_SCOPE_INVALID" },
    { code: "42501" },
    {
      get code() {
        throw Error("private");
      },
    },
  ])
    expect(isRetryablePilotDatabaseAcquisition(error)).toBe(false);
});
for (const [name, start] of [
  ["reconciliation", startPilotReconciliationWorker],
  ["dining", startPilotDiningExceptionWorker],
]) {
  it(name + " retains the same recovery and resumes after one acquisition failure", async () => {
    vi.useFakeTimers();
    const close = vi.fn(),
      recover = vi
        .fn()
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValue({ projectedCount: 0, scanComplete: true });
    await start({
      directory: "unused",
      createResources: async () => ({ close }),
      createRecovery: () => recover,
      startRuntime: async ({ workload }) => {
        await workload.start();
        expect(recover).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(4999);
        expect(recover).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(recover).toHaveBeenCalledTimes(2);
        await workload.stop();
        await vi.advanceTimersByTimeAsync(60000);
        expect(recover).toHaveBeenCalledTimes(2);
        expect(await workload.completion).toBe("stopped");
      },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(process.exitCode ?? 0).toBe(0);
  });
  it(name + " exhausts three retries with bounded backoff", async () => {
    vi.useFakeTimers();
    const close = vi.fn(),
      recover = vi.fn().mockRejectedValue(unavailable());
    await start({
      directory: "unused",
      createResources: async () => ({ close }),
      createRecovery: () => recover,
      startRuntime: async ({ workload }) => {
        await workload.start();
        await vi.advanceTimersByTimeAsync(5000);
        expect(recover).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(10000);
        expect(recover).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(20000);
        expect(recover).toHaveBeenCalledTimes(4);
        expect(await workload.completion).toBe("failed");
        await vi.advanceTimersByTimeAsync(60000);
        expect(recover).toHaveBeenCalledTimes(4);
        await workload.stop();
      },
    });
    expect(close).toHaveBeenCalledOnce();
  });
}
