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
import {
  HOSTED_LIVENESS_HEARTBEAT_MS,
  createHostedLivenessWriter,
} from "./pilot-workload-health.mjs";

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

const every = (task, ms) => {
  const timer = globalThis.setInterval(task, ms);
  timer.unref?.();
  return () => globalThis.clearInterval(timer);
};
/**
 * DEC-WORKER-HEALTH-TRUTH (v15 bc7e2965): each Store's workers as this process really has them,
 * in that Store's `store-workers.liveness.json`: `starting` until a first start, `running` once its
 * start succeeded and until it ends, `down` while its start failed or after it ended (since the
 * first failure, through the retries). Written on every change and every 30 s, so the supervisor
 * never reads a worker that refused to start as running.
 */
export function createStoreWorkersWorkload({
  directory,
  stores,
  services = starters,
  wait = delay,
  report = reportUnexpected,
  restartMs = RESTART_MS,
  staggerMs = STAGGER_MS,
  liveness = (storeDirectory) => createHostedLivenessWriter(storeDirectory),
  heartbeatMs = HOSTED_LIVENESS_HEARTBEAT_MS,
  repeat = every,
  now = Date.now,
}) {
  const stopping = new globalThis.AbortController();
  const running = new Set();
  const states = new Map(
    stores.map((relative) => [
      relative,
      { write: liveness(path.join(directory, relative)), services: {} },
    ]),
  );
  const publish = (relative) => {
    const store = states.get(relative);
    store.write({ ...store.services });
  };
  const mark = (relative, service, state) => {
    if (stopping.signal.aborted) return;
    const store = states.get(relative);
    if (store.services[service]?.state === state) return;
    store.services[service] = { state, since: new Date(now()).toISOString() };
    publish(relative);
  };
  let stopHeartbeat = () => undefined;
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
        mark(relative, service, "down");
        report("STORE_WORKLOAD_START_UNAVAILABLE", Error("STORE_WORKLOAD_NOT_STARTED"), details);
        await pause(restartMs);
        continue;
      }
      running.add(workload);
      try {
        await workload.start();
        mark(relative, service, "running");
        await Promise.race([
          ...(workload.completion === undefined ? [] : [workload.completion]),
          new Promise((resolve) => stopping.signal.addEventListener("abort", resolve)),
        ]);
      } catch (error) {
        report("STORE_WORKLOAD_FAILED", error, details);
      }
      running.delete(workload);
      mark(relative, service, "down");
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
      const at = new Date(now()).toISOString();
      for (const [relative, store] of states) {
        for (const service of Object.keys(services))
          store.services[service] = { state: "starting", since: at };
        publish(relative);
      }
      stopHeartbeat = repeat(() => {
        if (!stopping.signal.aborted) for (const relative of states.keys()) publish(relative);
      }, heartbeatMs);
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
      stopHeartbeat();
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
