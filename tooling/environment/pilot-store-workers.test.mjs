import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { expect, it, vi } from "vitest";
import { createStoreWorkersWorkload, parseStoreWorkersArguments } from "./pilot-store-workers.mjs";
import { startPilotDiningExceptionWorker } from "./pilot-dining-exception-worker.mjs";

// Health files are written under /proc identities (Linux); here only their snapshots are kept.
const health = vi.hoisted(() => []);
vi.mock("./pilot-workload-health.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  createPilotWorkloadHealthObserver: (_directory, component) => (snapshot) =>
    health.push({ component, state: snapshot.state }),
}));

const quick = (ms, _value, { signal } = {}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error("aborted"));
    const timer = setTimeout(resolve, Math.min(ms, 1));
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Error("aborted"));
    });
  });
const settle = async (until) => {
  for (let i = 0; i < 500 && !until(); i += 1) await new Promise((r) => setTimeout(r, 2));
  expect(until()).toBe(true);
};
const workload = (log, name) => {
  let end;
  const completion = new Promise((resolve) => {
    end = resolve;
  });
  return {
    end,
    completion,
    start: vi.fn(async () => log.push("start " + name)),
    stop: vi.fn(async () => log.push("stop " + name)),
  };
};
const options = (services, overrides = {}) => ({
  directory: "/install",
  stores: ["stores/a", "stores/b"],
  services,
  exists: async () => true,
  wait: quick,
  report: vi.fn(),
  ...overrides,
});

it("runs each Store's workers from that Store's directory and stops them all", async () => {
  const log = [],
    seen = [];
  const host = createStoreWorkersWorkload(
    options({
      "kitchen-queue-worker": async ({ directory, startRuntime }) => {
        seen.push(directory);
        await startRuntime({ workload: workload(log, directory) });
      },
    }),
  );
  await host.start();
  await settle(() => log.length === 2);
  expect(seen.sort()).toEqual(["/install/stores/a", "/install/stores/b"]);
  await host.stop();
  expect(await host.completion).toBe("stopped");
  expect(log.filter((line) => line.startsWith("stop"))).toHaveLength(2);
});

it("one Store's workload failing restarts on its own; the other is untouched", async () => {
  const log = [],
    started = { "/install/stores/a": [], "/install/stores/b": [] };
  const report = vi.fn();
  const host = createStoreWorkersWorkload(
    options(
      {
        "business-worker": async ({ directory, startRuntime }) => {
          const made = workload(log, directory);
          started[directory].push(made);
          await startRuntime({ workload: made });
        },
      },
      { report },
    ),
  );
  await host.start();
  await settle(
    () => started["/install/stores/a"].length === 1 && started["/install/stores/b"].length === 1,
  );
  started["/install/stores/a"][0].end("failed");
  await settle(() => started["/install/stores/a"].length === 2);
  expect(started["/install/stores/a"][0].stop).toHaveBeenCalledOnce();
  expect(started["/install/stores/b"]).toHaveLength(1);
  expect(started["/install/stores/b"][0].stop).not.toHaveBeenCalled();
  expect(report.mock.calls[0][2]).toEqual({ store: "stores/a:business-worker" });
  await host.stop();
});

it("a Store that can't start is logged and retried, without marking the process failed", async () => {
  const report = vi.fn(),
    log = [];
  let attempts = 0;
  const host = createStoreWorkersWorkload(
    options(
      {
        "business-worker": async ({ directory, startRuntime }) => {
          if (directory.endsWith("/a")) {
            attempts += 1;
            // A worker's start reports its failure on the process and returns.
            process.exitCode = 1;
            return;
          }
          await startRuntime({ workload: workload(log, directory) });
        },
      },
      { report },
    ),
  );
  await host.start();
  await settle(() => attempts >= 2 && log.length === 1);
  expect(process.exitCode).toBeUndefined();
  await host.stop();
  expect(report.mock.calls[0][2]).toEqual({ store: "stores/a:business-worker" });
});

it("a Store's settlement starts once its first closed day is recorded", async () => {
  const log = [];
  let covered = false;
  const host = createStoreWorkersWorkload(
    options(
      {
        "daily-settlement-worker": async ({ directory, startRuntime }) => {
          await startRuntime({ workload: workload(log, directory) });
        },
      },
      { stores: ["stores/a"], exists: async () => covered },
    ),
  );
  await host.start();
  await new Promise((r) => setTimeout(r, 20));
  expect(log).toEqual([]);
  covered = true;
  await settle(() => log.length === 1);
  await host.stop();
});

it("takes one runtime directory", () => {
  expect(parseStoreWorkersArguments([".local/pilot-v15"])).toBe(".local/pilot-v15");
  expect(() => parseStoreWorkersArguments([])).toThrow("STORE_WORKERS_ARGUMENT_INVALID");
});

// v15 2026-11-06 (points-sweep): the dining-exception worker's recovery and points sweep reach the
// Stores' shared process as the one workload it keeps; both run at each Store.
it("hosts a Store's dining-exception worker, its recovery and its points sweep, as one workload", async () => {
  const recover = vi.fn(async () => ({ projectedCount: 0, scanComplete: true }));
  const settlePoints = vi.fn(async () => 0);
  const close = vi.fn(async () => undefined);
  const report = vi.fn();
  const host = createStoreWorkersWorkload(
    options(
      {
        "dining-exception-worker": ({ directory, startRuntime }) =>
          startPilotDiningExceptionWorker({
            directory,
            startRuntime,
            providerAccountReference: "provider",
            createResources: async () => ({ close, publicProfile: { binding: {} } }),
            createRecovery: () => recover,
            createMemberSweep: async () => ({
              settlePoints,
              expirePoints: async () => ({ notified: 0, expired: 0 }),
            }),
          }),
      },
      { stores: ["stores/a"], report },
    ),
  );
  await host.start();
  await settle(() => recover.mock.calls.length > 0 && settlePoints.mock.calls.length > 0);
  expect(report).not.toHaveBeenCalled();
  expect(health.map((entry) => entry.component)).toContain("dining-exception-member-points");
  await host.stop();
  expect(close).toHaveBeenCalledOnce();
});
