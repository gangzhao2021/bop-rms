import { createConfiguredDailySettlementExecution } from "./pilot-daily-settlement-execution.mjs";
import console from "node:console";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { createBackgroundPilotResources } from "./pilot-configured-resources.mjs";
import process from "node:process";
import { startWorkerRuntime } from "../../apps/worker/dist/index.js";
import {
  createOutboxWorkload,
  supervisedCycleFailures,
} from "../../apps/worker/dist/outbox-workload.js";
import { createPilotWorkloadHealthObserver } from "./pilot-workload-health.mjs";
import { reportUnexpected } from "./pilot-unexpected.mjs";
export async function startPilotDailySettlementWorker({
  directory,
  createResources,
  startRuntime = startWorkerRuntime,
  createExecution = createConfiguredDailySettlementExecution,
}) {
  const resources = await createResources();
  let closing, execution;
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      try {
        await execution?.close();
      } finally {
        await resources.close();
      }
    }));
  try {
    execution = await createExecution(directory, resources);
    const loop = createOutboxWorkload({
      pollIntervalMs: 5000,
      drainDeadlineMs: 25000,
      // WP-2423 v15: supervised like the other pilot workloads — a failing cycle is retried
      // with backoff (attention when it persists), never stops the worker.
      supervision: supervisedCycleFailures,
      onSnapshot: createPilotWorkloadHealthObserver(directory, "daily-settlement-worker"),
      dispatcher: {
        runOnce: async () => {
          if (execution) {
            const progress = await execution.runOnce();
            if (
              !progress ||
              !["Idle", "Created", "Duplicate"].includes(progress.status) ||
              !Number.isSafeInteger(progress.checkCount) ||
              progress.checkCount < 0 ||
              progress.checkCount > 1
            )
              throw Error("DAILY_SETTLEMENT_EXECUTION_RESULT_INVALID");
            // Other days progressed; a day still failing keeps the cycle reported as failed.
            if (Object.hasOwn(progress, "failure")) throw progress.failure;
          }
          return 0;
        },
        stop: async () => "drained",
      },
    });
    await startRuntime({
      workload: {
        completion: loop.completion,
        start: () => loop.start(),
        stop: async () => {
          try {
            await loop.stop();
          } finally {
            await close();
          }
        },
      },
    });
  } catch (error) {
    // v15 2026-10-31: never a silent start failure — its code (no secrets or ids) goes to the log.
    reportUnexpected("DAILY_SETTLEMENT_WORKER_START_UNAVAILABLE", error);
    await close();
    process.exitCode = 1;
  }
}

export function parseDailySettlementWorkerArguments(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string")
    throw Error("DAILY_SETTLEMENT_WORKER_ARGUMENT_INVALID");
  return parsePilotRuntimeDirectory(args[0]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtimeDirectory = parseDailySettlementWorkerArguments(process.argv.slice(2));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = path.join(root, runtimeDirectory);
    await startPilotDailySettlementWorker({
      directory,
      createResources: () => createBackgroundPilotResources(directory),
    });
  } catch (error) {
    reportUnexpected("DAILY_SETTLEMENT_WORKER_START_UNAVAILABLE", error);
    console.error("DAILY_SETTLEMENT_WORKER_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}
