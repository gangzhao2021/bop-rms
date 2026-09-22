import { isRetryablePilotDatabaseAcquisition } from "./pilot-database-retry.mjs";
import { createConfiguredReconciliationExecution } from "./pilot-reconciliation-execution.mjs";
import console from "node:console";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { createConfiguredPilotResources } from "./pilot-configured-resources.mjs";
import process from "node:process";
import { startWorkerRuntime } from "../../apps/worker/dist/index.js";
import { createOutboxWorkload } from "../../apps/worker/dist/outbox-workload.js";
import { createInternalReconciliationProjection } from "./pilot-reconciliation-projection.mjs";
import { createPilotWorkloadHealthObserver } from "./pilot-workload-health.mjs";
export async function startPilotReconciliationWorker({
  directory,
  createResources,
  createRecovery = createInternalReconciliationProjection,
  startRuntime = startWorkerRuntime,
  operational = false,
  providerCaptureReview = false,
  createExecution = createConfiguredReconciliationExecution,
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
    if (providerCaptureReview && !operational)
      throw Error("RECONCILIATION_CAPTURE_CONFIGURATION_INVALID");
    if (operational)
      execution = await createExecution(directory, resources, { providerCaptureReview });
    const recover = createRecovery(resources);
    const loop = createOutboxWorkload({
      pollIntervalMs: 5000,
      drainDeadlineMs: 25000,
      retry: { maxRetries: 3, shouldRetry: isRetryablePilotDatabaseAcquisition },
      onSnapshot: createPilotWorkloadHealthObserver(directory, "reconciliation-worker"),
      dispatcher: {
        runOnce: async () => {
          if (providerCaptureReview) {
            const capture = await execution.reviewCaptures();
            const counts = [capture?.created, capture?.alreadyRecorded, capture?.operationPresent];
            if (
              !capture ||
              !Number.isSafeInteger(capture.scannedCount) ||
              capture.scannedCount < 0 ||
              capture.scannedCount > 5 ||
              typeof capture.scanComplete !== "boolean" ||
              counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
              counts.reduce((a, b) => a + b, 0) !== capture.scannedCount
            )
              throw Error("RECONCILIATION_CAPTURE_RESULT_INVALID");
          }
          if (execution) {
            const progress = await execution.runOnce();
            if (
              !progress ||
              !["Idle", "Created", "Duplicate"].includes(progress.status) ||
              !Number.isSafeInteger(progress.checkCount) ||
              progress.checkCount < 0 ||
              progress.checkCount > 100
            )
              throw Error("RECONCILIATION_EXECUTION_RESULT_INVALID");
          }
          const result = await recover();
          if (
            !result ||
            !Number.isSafeInteger(result.projectedCount) ||
            result.projectedCount < 0 ||
            result.projectedCount > 5 ||
            typeof result.scanComplete !== "boolean"
          )
            throw Error("RECONCILIATION_RECOVERY_RESULT_INVALID");
          return result.projectedCount;
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

export function parseReconciliationWorkerArguments(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string")
    throw Error("RECONCILIATION_WORKER_ARGUMENT_INVALID");
  return parsePilotRuntimeDirectory(args[0]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtimeDirectory = parseReconciliationWorkerArguments(process.argv.slice(2));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = path.join(root, runtimeDirectory);
    await startPilotReconciliationWorker({
      directory,
      operational: true,
      providerCaptureReview: true,
      createResources: () => createConfiguredPilotResources(directory),
    });
  } catch {
    console.error("RECONCILIATION_WORKER_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}
