import console from "node:console";
import process from "node:process";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { createConfiguredPilotApiRuntime } from "./pilot-customer-composition.mjs";
import { startApiRuntime } from "../../apps/api/dist/server.js";
import { isPilotRuntime } from "./pilot-environment.mjs";
import { loadServedStoreDirectories } from "./pilot-served-stores.mjs";

/** Another Store's API in this process: it listens; the process signals stop the first one. */
async function startStoreApiRuntime(runtime) {
  await runtime.listen();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void runtime.shutdown(signal).catch(() => undefined));
}
export function parsePilotApiArguments(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string")
    throw Error("PILOT_API_ARGUMENT_INVALID");
  return parsePilotRuntimeDirectory(args[0]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!isPilotRuntime() || process.env.PORT !== "4300")
      throw Error("PILOT_API_ENVIRONMENT_INVALID");
    const dir = path.join(
      fileURLToPath(new URL("../../", import.meta.url)),
      parsePilotApiArguments(process.argv.slice(2)),
    );
    startApiRuntime(await createConfiguredPilotApiRuntime(dir, { port: 4300 }));
    // DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: each other Store this installation serves has its
    // own customer API on the next local port, in this same process (stores.json order).
    for (const [index, relative] of (await loadServedStoreDirectories(dir)).entries())
      await startStoreApiRuntime(
        await createConfiguredPilotApiRuntime(path.join(dir, relative), { port: 4301 + index }),
      );
  } catch {
    console.error("PILOT_API_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}
