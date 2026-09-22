import { createConfiguredDailySettlementExecution } from "./pilot-daily-settlement-execution.mjs";
import console from "node:console";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { createConfiguredPilotResources } from "./pilot-configured-resources.mjs";
import process from "node:process";
import { startWorkerRuntime } from "../../apps/worker/dist/index.js";
import { createOutboxWorkload } from "../../apps/worker/dist/outbox-workload.js";
import { createPilotWorkloadHealthObserver } from "./pilot-workload-health.mjs";
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
      retry: { maxRetries: 3, shouldRetry: isRetryableDailySettlementFailure },
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
  } catch {
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
      createResources: () => createConfiguredPilotResources(directory),
    });
  } catch {
    console.error("DAILY_SETTLEMENT_WORKER_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}

export function isRetryableDailySettlementFailure(error) {
  try {
    if (!error || typeof error !== "object") return false;
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    if (code === "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE") return true;
    const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
    return [
      "DAILY_SETTLEMENT_SOURCE_UNAVAILABLE",
      "SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE",
      "tenant database connection is unavailable",
    ].includes(message);
  } catch {
    return false;
  }
}
