import { afterEach, expect, it, vi } from "vitest";
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
