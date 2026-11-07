import console from "node:console";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { startWorkerRuntime } from "../../apps/worker/dist/index.js";
import { loadAdmittedServedStores } from "./pilot-admitted-stores.mjs";
import { startConfiguredBusinessWorker } from "./pilot-business-worker.mjs";
import { createBackgroundPilotResources } from "./pilot-configured-resources.mjs";
import { startPilotDailySettlementWorker } from "./pilot-daily-settlement-worker.mjs";
import { startConfiguredDiningExceptionWorker } from "./pilot-dining-exception-worker.mjs";
import { startConfiguredKitchenWorker } from "./pilot-kitchen-queue-worker.mjs";
import { startPilotReconciliationWorker } from "./pilot-reconciliation-worker.mjs";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { reportUnexpected } from "./pilot-unexpected.mjs";
import { startPilotBusinessWorker, startPilotKitchenWorker } from "./pilot-worker-entry.mjs";

/**
 * DEC-MULTI-MERCHANT-ONE-INSTALLATION A5: the workers of every Store after the installation's first,
 * in one process and one connection pool. Each Store's memory and connections no longer pay for five
 * processes. One Store's workload failing is logged and restarted on its own; the others carry on.
 * Every service starts for every admitted Store: a Store's day-end settlement worker waits on its
 * own until the Store's first business day has closed (WP-2423), it is never left unstarted.
 */
const RESTART_MS = 30_000,
  STAGGER_MS = 250;
const starters = Object.freeze({
  "business-worker": ({ directory, startRuntime }) =>
    startConfiguredBusinessWorker({
      directory,
      startWorker: (options) => startPilotBusinessWorker({ ...options, startRuntime }),
    }),
  "kitchen-queue-worker": ({ directory, startRuntime }) =>
    startConfiguredKitchenWorker({
      directory,
      startWorker: (options) => startPilotKitchenWorker({ ...options, startRuntime }),
    }),
  "reconciliation-worker": ({ directory, startRuntime }) =>
    startPilotReconciliationWorker({
      directory,
      operational: true,
      providerCaptureReview: true,
      startRuntime,
      createResources: () => createBackgroundPilotResources(directory),
    }),
  "daily-settlement-worker": ({ directory, startRuntime }) =>
    startPilotDailySettlementWorker({
      directory,
      startRuntime,
      createResources: () => createBackgroundPilotResources(directory),
    }),
  "dining-exception-worker": ({ directory, startRuntime }) =>
    startConfiguredDiningExceptionWorker({ directory, startRuntime }),
});

export function createStoreWorkersWorkload({
  directory,
  stores,
  services = starters,
  wait = delay,
  report = reportUnexpected,
  restartMs = RESTART_MS,
  staggerMs = STAGGER_MS,
}) {
  const stopping = new globalThis.AbortController();
  const running = new Set();
  const pause = (ms) => wait(ms, undefined, { signal: stopping.signal }).catch(() => undefined);
  let finished;
  const completion = new Promise((resolve) => {
    finished = resolve;
  });
  async function supervise(relative, service, start) {
    const storeDirectory = path.join(directory, relative);
    const details = { store: relative + ":" + service };
    while (!stopping.signal.aborted) {
      let workload = null;
      // A worker's start reports its own failure on the process; this process keeps serving.
      const exitCode = process.exitCode;
      try {
        await start({
          directory: storeDirectory,
          startRuntime: async (options) => {
            workload = options.workload;
          },
        });
      } catch (error) {
        report("STORE_WORKLOAD_START_UNAVAILABLE", error, details);
      }
      process.exitCode = exitCode;
      if (workload === null) {
        report("STORE_WORKLOAD_START_UNAVAILABLE", Error("STORE_WORKLOAD_NOT_STARTED"), details);
        await pause(restartMs);
        continue;
      }
      running.add(workload);
      try {
        await workload.start();
        await Promise.race([
          ...(workload.completion === undefined ? [] : [workload.completion]),
          new Promise((resolve) => stopping.signal.addEventListener("abort", resolve)),
        ]);
      } catch (error) {
        report("STORE_WORKLOAD_FAILED", error, details);
      }
      running.delete(workload);
      await workload.stop().catch((error) => report("STORE_WORKLOAD_FAILED", error, details));
      if (stopping.signal.aborted) break;
      report("STORE_WORKLOAD_FAILED", Error("STORE_WORKLOAD_ENDED"), details);
      await pause(restartMs);
    }
  }
  const tasks = [];
  return Object.freeze({
    completion,
    async start() {
      let order = 0;
      for (const relative of stores)
        for (const [service, start] of Object.entries(services)) {
          const position = order++;
          tasks.push(
            pause(position * staggerMs).then(() =>
              stopping.signal.aborted ? undefined : supervise(relative, service, start),
            ),
          );
        }
    },
    async stop() {
      stopping.abort();
      await Promise.allSettled(tasks);
      finished("stopped");
    },
  });
}

export function parseStoreWorkersArguments(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string")
    throw Error("STORE_WORKERS_ARGUMENT_INVALID");
  return parsePilotRuntimeDirectory(args[0]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtimeDirectory = parseStoreWorkersArguments(process.argv.slice(2));
    const directory = path.join(
      fileURLToPath(new URL("../../", import.meta.url)),
      runtimeDirectory,
    );
    await startWorkerRuntime({
      workload: createStoreWorkersWorkload({
        directory,
        stores: await loadAdmittedServedStores(directory),
      }),
    });
  } catch (error) {
    reportUnexpected("STORE_WORKERS_START_UNAVAILABLE", error);
    console.error("STORE_WORKERS_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}
