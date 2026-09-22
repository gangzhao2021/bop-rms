import { afterEach, expect, it, vi } from "vitest";
import process from "node:process";
vi.mock("./pilot-workload-health.mjs", () => ({
  createPilotWorkloadHealthObserver: () => vi.fn(),
}));
import {
  startPilotReconciliationWorker,
  parseReconciliationWorkerArguments,
} from "./pilot-reconciliation-worker.mjs";
afterEach(() => {
  process.exitCode = 0;
});
it("constructs without scanning and runs only projection recovery with graceful resource cleanup", async () => {
  const recover = vi.fn(async () => ({ projectedCount: 0, scanComplete: true })),
    close = vi.fn(async () => undefined);
  await startPilotReconciliationWorker({
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
it("reports failed isolated process and closes resources when owner scan fails", async () => {
  const close = vi.fn(async () => undefined),
    recover = vi.fn(async () => {
      throw Error("owner unavailable");
    });
  await startPilotReconciliationWorker({
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
  expect(process.exitCode).toBe(1);
  expect(close).toHaveBeenCalledOnce();
});
it("rejects malformed recovery progress", async () => {
  const close = vi.fn(async () => undefined);
  await startPilotReconciliationWorker({
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
  expect(process.exitCode).toBe(1);
  expect(close).toHaveBeenCalledOnce();
});

it("accepts only one explicit local installation argument", () => {
  expect(parseReconciliationWorkerArguments([".local/pilot-installation"])).toBe(
    ".local/pilot-installation",
  );
  for (const args of [
    [],
    ["/tmp/pilot"],
    [".local/../pilot"],
    [".local/pilot-installation", "extra"],
    [undefined],
  ])
    expect(() => parseReconciliationWorkerArguments(args)).toThrow();
});

it("runs explicitly enabled reconciliation before projection and closes its Provider", async () => {
  const events = [],
    close = vi.fn(async () => undefined),
    providerClose = vi.fn(async () => undefined);
  await startPilotReconciliationWorker({
    directory: "unused",
    operational: true,
    createResources: async () => ({ close }),
    createExecution: async () => ({
      runOnce: async () => {
        events.push("execute");
        return { status: "Created", checkCount: 27 };
      },
      close: providerClose,
    }),
    createRecovery: () => async () => {
      events.push("project");
      return { projectedCount: 0, scanComplete: true };
    },
    startRuntime: async ({ workload }) => {
      await workload.start();
      await workload.stop();
    },
  });
  expect(events).toEqual(["execute", "project"]);
  expect(providerClose).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it("fails and closes both resources when explicit execution fails", async () => {
  const close = vi.fn(async () => undefined),
    providerClose = vi.fn(async () => undefined),
    recover = vi.fn(async () => ({ projectedCount: 0, scanComplete: true }));
  await startPilotReconciliationWorker({
    directory: "unused",
    operational: true,
    createResources: async () => ({ close }),
    createExecution: async () => ({
      runOnce: async () => {
        throw Error("execution failed");
      },
      close: providerClose,
    }),
    createRecovery: () => recover,
    startRuntime: async ({ workload }) => {
      try {
        await workload.start();
      } finally {
        await workload.stop();
      }
    },
  });
  expect(recover).not.toHaveBeenCalled();
  expect(providerClose).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(1);
});

it.each([false, true])(
  "runs bounded capture review before reconciliation and projection; malformed=%s",
  async (malformed) => {
    const events = [],
      close = vi.fn(),
      providerClose = vi.fn();
    await startPilotReconciliationWorker({
      directory: "unused",
      operational: true,
      providerCaptureReview: true,
      createResources: async () => ({ close }),
      createExecution: async (_directory, _resources, options) => {
        expect(options).toEqual({ providerCaptureReview: true });
        return {
          reviewCaptures: async () => {
            events.push("capture");
            return {
              scannedCount: 1,
              created: malformed ? 2 : 1,
              alreadyRecorded: 0,
              operationPresent: 0,
              scanComplete: true,
            };
          },
          runOnce: async () => {
            events.push("execute");
            return { status: "Idle", checkCount: 0 };
          },
          close: providerClose,
        };
      },
      createRecovery: () => async () => {
        events.push("project");
        return { projectedCount: 1, scanComplete: true };
      },
      startRuntime: async ({ workload }) => {
        try {
          await workload.start();
        } finally {
          await workload.stop();
        }
      },
    });
    expect(events).toEqual(malformed ? ["capture"] : ["capture", "execute", "project"]);
    expect(process.exitCode).toBe(malformed ? 1 : 0);
    expect(providerClose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);
it("rejects capture activation without configured operational ownership", async () => {
  const close = vi.fn(),
    createExecution = vi.fn(),
    startRuntime = vi.fn();
  await startPilotReconciliationWorker({
    directory: "unused",
    providerCaptureReview: true,
    createResources: async () => ({ close }),
    createExecution,
    startRuntime,
  });
  expect(createExecution).not.toHaveBeenCalled();
  expect(startRuntime).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(1);
});
