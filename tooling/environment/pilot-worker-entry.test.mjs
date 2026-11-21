import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import process from "node:process";
import { startPilotBusinessWorker, startPilotKitchenWorker } from "./pilot-worker-entry.mjs";
const originalExitCode = process.exitCode;
let directory;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bop-worker-entry-"));
});
afterEach(() => {
  process.exitCode = originalExitCode;
  rmSync(directory, { recursive: true, force: true });
});
test("Kitchen construction failure closes resources without starting", async () => {
  const close = vi.fn(async () => undefined),
    startRuntime = vi.fn();
  await startPilotKitchenWorker({
    directory,
    createInternalTestResources: async () => ({ close }),
    createInternalKitchenQueue: () => {
      throw new Error("MODEL_UNAVAILABLE");
    },
    startRuntime,
  });
  expect(close).toHaveBeenCalledTimes(1);
  expect(startRuntime).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
test("business startup failure closes once after workload stop", async () => {
  const close = vi.fn(async () => undefined),
    stop = vi.fn(async () => undefined);
  await startPilotBusinessWorker({
    directory,
    createInternalTestResources: async () => ({ close }),
    createInternalWorker: async () => ({ workload: { stop } }),
    startRuntime: async ({ workload }) => {
      await workload.stop();
      throw new Error("START_UNAVAILABLE");
    },
  });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
});

test.each([undefined, true])(
  "cancellation opt-in reaches worker and health observer: %s",
  async (enabled) => {
    const close = vi.fn(async () => undefined),
      stop = vi.fn(async () => undefined),
      createInternalWorker = vi.fn(async () => ({ workload: { stop } }));
    await startPilotBusinessWorker({
      directory,
      enableBatchCancellation: enabled,
      createInternalTestResources: async () => ({ close }),
      createInternalWorker,
      startRuntime: async ({ workload }) => workload.stop(),
    });
    const [, observers, options] = createInternalWorker.mock.calls[0];
    expect(options.batchCancellation).toBe(enabled === true);
    expect(typeof observers.batchCancellation).toBe(enabled === true ? "function" : "undefined");
    expect(close).toHaveBeenCalledTimes(1);
  },
);

test.each([undefined, true])(
  "compensation opt-in reaches worker and health observer: %s",
  async (enabled) => {
    const close = vi.fn(async () => undefined),
      createInternalWorker = vi.fn(async () => ({ workload: { stop: async () => undefined } }));
    await startPilotBusinessWorker({
      directory,
      enableCompensation: enabled,
      createInternalTestResources: async () => ({ close }),
      createInternalWorker,
      startRuntime: async ({ workload }) => workload.stop(),
    });
    const [, observers, options] = createInternalWorker.mock.calls[0];
    expect(options.compensation).toBe(enabled === true);
    expect(typeof observers.compensation).toBe(enabled === true ? "function" : "undefined");
    expect(close).toHaveBeenCalledOnce();
  },
);
