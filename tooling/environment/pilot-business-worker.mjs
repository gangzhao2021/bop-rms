import console from "node:console";
import process from "node:process";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createConfiguredPilotResources } from "./pilot-configured-resources.mjs";
import { composeConfiguredBusinessWorker } from "./pilot-business-composition.mjs";
import { startPilotBusinessWorker } from "./pilot-worker-entry.mjs";

export function parseBusinessWorkerArguments(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string")
    throw Error("BUSINESS_WORKER_ARGUMENT_INVALID");
  return parsePilotRuntimeDirectory(args[0]);
}
export async function startConfiguredBusinessWorker({
  directory,
  loadInstallation = loadPilotInstallation,
  createResources = createConfiguredPilotResources,
  composeWorker = composeConfiguredBusinessWorker,
  startWorker = startPilotBusinessWorker,
}) {
  const installation = await loadInstallation(directory);
  const config = await installation.loadBusinessWorker();
  return startWorker({
    directory,
    enableBatchCancellation: config.workloads?.batchCancellation === true,
    enableCompensation: config.workloads?.compensation === true,
    createInternalTestResources: async () => {
      const resources = await createResources(directory);
      if (
        Object.entries(config.scope).some(
          ([key, value]) => resources.publicProfile.binding[key] !== value,
        )
      ) {
        await resources.close();
        throw Error("BUSINESS_WORKER_SCOPE_CHANGED");
      }
      return resources;
    },
    createInternalWorker: composeWorker({ directory, installation, config }),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtimeDirectory = parseBusinessWorkerArguments(process.argv.slice(2));
    await startConfiguredBusinessWorker({
      directory: path.join(fileURLToPath(new URL("../../", import.meta.url)), runtimeDirectory),
    });
  } catch {
    console.error("BUSINESS_WORKER_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}
