import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { runPilotService } from "./pilot-service.mjs";
import { acquirePilotSupervisorLease } from "./pilot-supervisor.mjs";
import { expect, it, vi } from "vitest";
import { runPilotSupervisor } from "./pilot-supervisor.mjs";
const runtimeDirectory = ".local/pilot-v14";
it("drains current sweep before releasing ownership on stop", async () => {
  const controller = new globalThis.AbortController();
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const release = vi.fn(),
    acquire = vi.fn(async () => release),
    observe = vi.fn(),
    wait = vi.fn();
  const sweep = { sweep: vi.fn(() => pending) };
  const running = runPilotSupervisor({
    runtimeDirectory,
    signal: controller.signal,
    acquire,
    sweep,
    observe,
    wait,
  });
  await Promise.resolve();
  controller.abort();
  expect(release).not.toHaveBeenCalled();
  finish([]);
  await running;
  expect(release).toHaveBeenCalledTimes(1);
  expect(observe).not.toHaveBeenCalled();
  expect(wait).not.toHaveBeenCalled();
});
it("stops an idle wait without another sweep and releases ownership", async () => {
  const controller = new globalThis.AbortController(),
    release = vi.fn();
  const sweep = { sweep: vi.fn(async () => []) };
  await runPilotSupervisor({
    runtimeDirectory,
    signal: controller.signal,
    acquire: async () => release,
    sweep,
    wait: async (_ms, _value, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw Error("aborted");
    },
  });
  expect(sweep.sweep).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});
it("refuses a second owner before sweeping, and releases after an observer failure", async () => {
  const controller = new globalThis.AbortController(),
    sweep = { sweep: vi.fn(async () => []) },
    release = vi.fn();
  await expect(
    runPilotSupervisor({
      runtimeDirectory,
      signal: controller.signal,
      sweep,
      acquire: async () => {
        throw Error("owned");
      },
    }),
  ).rejects.toThrow("owned");
  expect(sweep.sweep).not.toHaveBeenCalled();
  await expect(
    runPilotSupervisor({
      runtimeDirectory,
      signal: controller.signal,
      sweep,
      acquire: async () => release,
      observe: () => {
        throw Error("sink failed");
      },
    }),
  ).rejects.toThrow("sink failed");
  expect(release).toHaveBeenCalledTimes(1);
});
it("does not acquire when already stopped", async () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  const acquire = vi.fn();
  await runPilotSupervisor({ runtimeDirectory, signal: controller.signal, acquire });
  expect(acquire).not.toHaveBeenCalled();
});

it("owns one real private lease and blocks maintenance until it is released", async () => {
  await fs.mkdir(".local", { recursive: true, mode: 0o700 });
  const directory = ".local/supervisor-test-" + randomUUID();
  await fs.mkdir(directory, { mode: 0o700 });
  let release;
  try {
    await fs.mkdir(directory + "/business-worker.restart-lock", { mode: 0o700 });
    await expect(acquirePilotSupervisorLease(directory)).rejects.toThrow(
      "PILOT_MAINTENANCE_IN_PROGRESS",
    );
    await expect(fs.lstat(directory + "/supervisor.lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.rmdir(directory + "/business-worker.restart-lock");
    release = await acquirePilotSupervisorLease(directory);
    await expect(acquirePilotSupervisorLease(directory)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(runPilotService("stop", "business-worker", directory)).rejects.toThrow(
      "PILOT_SUPERVISOR_MUST_STOP_FIRST",
    );
    await expect(runPilotService("restart", "business-worker", directory)).rejects.toThrow(
      "PILOT_SUPERVISOR_MUST_STOP_FIRST",
    );
    await release();
    await release();
    await expect(fs.lstat(directory + "/supervisor.lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (release) await release();
    await fs.rmdir(directory);
  }
});
