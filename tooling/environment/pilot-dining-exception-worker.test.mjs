import { afterEach, expect, it, vi } from "vitest";
import console from "node:console";
import process from "node:process";
const health = vi.hoisted(() => ({ snapshots: [] }));
vi.mock("./pilot-workload-health.mjs", () => ({
  createPilotWorkloadHealthObserver: () => (snapshot) => health.snapshots.push(snapshot),
}));
// WP-2423 v15: a failed cycle is reported in health and retried; the worker keeps running.
const cycleFailed = () => health.snapshots.some((snapshot) => snapshot.lastCycleFailure !== null);
import {
  startPilotDiningExceptionWorker,
  parseDiningExceptionWorkerArguments,
} from "./pilot-dining-exception-worker.mjs";
afterEach(() => {
  process.exitCode = 0;
  health.snapshots.length = 0;
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

// WP-2423 取舍 18: each Store's own worker settles points for its directory; a failure is reported
// and never stops the worker's own work.
it("sweeps points for its own Store's directory, at most every five minutes, and survives a failure", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const settlePoints = vi
    .fn()
    .mockRejectedValueOnce(new Error("MEMBER_SWEEP_STAND_IN"))
    .mockResolvedValue(0);
  const expirePoints = vi.fn().mockResolvedValue({ notified: 0, expired: 0 });
  const createMemberSweep = vi.fn(async () => ({ settlePoints, expirePoints }));
  const recover = vi.fn(async () => ({ projectedCount: 0, scanComplete: true }));
  const resources = { close: vi.fn(async () => undefined), publicProfile: { binding: {} } };
  const stopped = new Promise((resolve) => {
    void startPilotDiningExceptionWorker({
      directory: "stores/demo-2",
      providerAccountReference: "provider",
      createResources: async () => resources,
      createRecovery: () => recover,
      createMemberSweep,
      startRuntime: async ({ workload }) => {
        await workload.start();
        await vi.waitFor(() => expect(recover).toHaveBeenCalled(), { timeout: 8000 });
        await workload.stop();
        resolve();
      },
    });
  });
  await stopped;
  expect(createMemberSweep).toHaveBeenCalledWith({
    directory: "stores/demo-2",
    resources,
    providerAccountReference: "provider",
  });
  expect(settlePoints).toHaveBeenCalledTimes(1);
  expect(recover).toHaveBeenCalled();
  expect(String(report.mock.calls[0]?.[0])).toContain("MEMBER_POINTS_SWEEP_UNAVAILABLE");
  expect(String(report.mock.calls[0]?.[0])).not.toContain("613");
  report.mockRestore();
}, 15000);
