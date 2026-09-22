import console from "node:console";
import process from "node:process";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { createConfiguredPilotApiRuntime } from "./pilot-customer-composition.mjs";
import { startApiRuntime } from "../../apps/api/dist/server.js";
export function parsePilotApiArguments(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string")
    throw Error("PILOT_API_ARGUMENT_INVALID");
  return parsePilotRuntimeDirectory(args[0]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.NODE_ENV !== "development" || process.env.PORT !== "4300")
      throw Error("PILOT_API_ENVIRONMENT_INVALID");
    const dir = path.join(
      fileURLToPath(new URL("../../", import.meta.url)),
      parsePilotApiArguments(process.argv.slice(2)),
    );
    startApiRuntime(await createConfiguredPilotApiRuntime(dir, { port: 4300 }));
  } catch {
    console.error("PILOT_API_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}
