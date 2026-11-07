import { withPilotMaintenance } from "./pilot-maintenance.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { servedStoreWorkerTargets } from "./pilot-recovery-sweep.mjs";
import { loadServedStoreDirectories } from "./pilot-served-stores.mjs";
import console from "node:console";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  runPilotService,
  parsePilotRuntimeDirectory,
  pilotRuntimeDirectory,
} from "./pilot-service.mjs";
export async function stopPilotRuntime({
  runtimeDirectory = pilotRuntimeDirectory,
  service = runPilotService,
  maintenance = withPilotMaintenance,
  // DEC-BRAND-MULTI-STORE (v15 2026-10-31): the served Stores, whose workers stop in the same window.
  listStores = async () =>
    loadServedStoreDirectories(path.join(await fs.realpath(process.cwd()), runtimeDirectory)),
} = {}) {
  runtimeDirectory = parsePilotRuntimeDirectory(runtimeDirectory);
  return maintenance(
    runtimeDirectory,
    async () => {
      const completed = [];
      const names = [
        "customer",
        "api",
        "business-worker",
        "kitchen-queue-worker",
        "reconciliation-worker",
        "daily-settlement-worker",
        "dining-exception-worker",
      ];
      const targets = [
        ...names.map((name) => ({ name, directory: runtimeDirectory, label: name })),
        ...(await servedStoreWorkerTargets(runtimeDirectory, listStores)),
      ];
      for (const { name, directory, label } of targets) {
        try {
          const result = await service("stop", name, directory);
          if (result?.service !== name || result.state !== "stopped")
            throw Error("PILOT_STOP_NOT_CONFIRMED");
          completed.push(directory === runtimeDirectory ? result : { ...result, service: label });
        } catch {
          return { state: "incomplete", stage: label, completed, code: "PILOT_STOP_UNAVAILABLE" };
        }
      }
      return { state: "stopped", services: completed };
    },
    "Stop",
  );
}
export function parsePilotStopArguments(args) {
  if (!Array.isArray(args) || args.length > 1 || args.some((v) => typeof v !== "string"))
    throw Error("PILOT_STOP_ARGUMENT_INVALID");
  return { runtimeDirectory: parsePilotRuntimeDirectory(args[0] ?? pilotRuntimeDirectory) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await stopPilotRuntime(parsePilotStopArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if (result.state !== "stopped") process.exitCode = 1;
  } catch {
    console.error("PILOT_STOP_ARGUMENT_INVALID");
    process.exitCode = 1;
  }
}
