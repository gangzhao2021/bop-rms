import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { expect, it, vi } from "vitest";
import { createStoreWorkersWorkload, parseStoreWorkersArguments } from "./pilot-store-workers.mjs";

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

// WP-2423 (settlement-coverage): no Store waits for a coverage file nobody writes; the worker
// itself waits until the Store's first business day has closed.
it("a Store's settlement worker starts on the first pass, with no coverage file", async () => {
  const log = [];
  const host = createStoreWorkersWorkload(
    options(
      {
        "daily-settlement-worker": async ({ directory, startRuntime }) => {
          await startRuntime({ workload: workload(log, directory) });
        },
      },
      { stores: ["stores/a"], directory: "/no-such-install" },
    ),
  );
  await host.start();
  await settle(() => log.length === 1);
  expect(log).toEqual(["start /no-such-install/stores/a"]);
  await host.stop();
});

it("takes one runtime directory", () => {
  expect(parseStoreWorkersArguments([".local/pilot-v15"])).toBe(".local/pilot-v15");
  expect(() => parseStoreWorkersArguments([])).toThrow("STORE_WORKERS_ARGUMENT_INVALID");
});
