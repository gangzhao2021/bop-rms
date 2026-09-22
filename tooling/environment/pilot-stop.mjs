import { withPilotMaintenance } from "./pilot-maintenance.mjs";
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
      for (const name of names) {
        try {
          const result = await service("stop", name, runtimeDirectory);
          if (result?.service !== name || result.state !== "stopped")
            throw Error("PILOT_STOP_NOT_CONFIRMED");
          completed.push(result);
        } catch {
          return { state: "incomplete", stage: name, completed, code: "PILOT_STOP_UNAVAILABLE" };
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
