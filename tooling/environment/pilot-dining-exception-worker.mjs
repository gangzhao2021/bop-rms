import { isRetryablePilotDatabaseAcquisition } from "./pilot-database-retry.mjs";
import console from "node:console";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createConfiguredPilotResources } from "./pilot-configured-resources.mjs";
import process from "node:process";
import { startWorkerRuntime } from "../../apps/worker/dist/index.js";
import { createOutboxWorkload } from "../../apps/worker/dist/outbox-workload.js";
import { createInternalDiningProjection } from "./pilot-dining-projection.mjs";
import { createPilotWorkloadHealthObserver } from "./pilot-workload-health.mjs";
export async function startPilotDiningExceptionWorker({
  directory,
  createResources,
  providerAccountReference,
  createRecovery = createInternalDiningProjection,
  startRuntime = startWorkerRuntime,
}) {
  const resources = await createResources();
  let closing;
  const close = () => (closing ??= Promise.resolve().then(() => resources.close()));
  try {
    const recover = createRecovery({ resources, providerAccountReference });
    const loop = createOutboxWorkload({
      pollIntervalMs: 5000,
      drainDeadlineMs: 25000,
      retry: { maxRetries: 3, shouldRetry: isRetryablePilotDatabaseAcquisition },
      onSnapshot: createPilotWorkloadHealthObserver(directory, "dining-exception-worker"),
      dispatcher: {
        runOnce: async () => {
          const result = await recover();
          if (
            !result ||
            !Number.isSafeInteger(result.projectedCount) ||
            result.projectedCount < 0 ||
            result.projectedCount > 5 ||
            typeof result.scanComplete !== "boolean"
          )
            throw Error("DINING_EXCEPTION_RECOVERY_RESULT_INVALID");
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

export function parseDiningExceptionWorkerArguments(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string")
    throw Error("DINING_EXCEPTION_WORKER_ARGUMENT_INVALID");
  return parsePilotRuntimeDirectory(args[0]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtimeDirectory = parseDiningExceptionWorkerArguments(process.argv.slice(2));
    const directory = path.join(
      fileURLToPath(new URL("../../", import.meta.url)),
      runtimeDirectory,
    );
    const installation = await loadPilotInstallation(directory);
    const config = await installation.loadDiningExceptionWorker();
    await startPilotDiningExceptionWorker({
      directory,
      providerAccountReference: config.providerAccountReference,
      createResources: async () => {
        const resources = await createConfiguredPilotResources(directory);
        if (
          Object.entries(config.scope).some(
            ([key, value]) => resources.publicProfile.binding[key] !== value,
          )
        ) {
          await resources.close();
          throw Error("DINING_EXCEPTION_WORKER_SCOPE_CHANGED");
        }
        return resources;
      },
    });
  } catch {
    console.error("DINING_EXCEPTION_WORKER_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}
