import { isAbsolute, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkerWorkload } from "./index.js";

/** Trusted local executable configuration. Import must not start work; stop owns
 * connection cleanup, including partial startup. No environment or secret defaults.
 */
export async function loadWorkerProcessConfiguration(
  args: readonly string[],
): Promise<{ workload?: WorkerWorkload }> {
  if (args.length === 0) return {};
  if (
    args.length !== 2 ||
    args[0] !== "--configuration" ||
    !args[1] ||
    !isAbsolute(args[1]) ||
    ![".js", ".mjs"].includes(extname(args[1]))
  )
    throw new Error("WORKER_CONFIGURATION_INVALID");
  try {
    const loaded: unknown = await import(pathToFileURL(args[1]).href);
    if (typeof loaded !== "object" || loaded === null) throw new Error("invalid module");
    const workload: unknown = "workload" in loaded ? loaded.workload : undefined;
    if (
      typeof workload !== "object" ||
      workload === null ||
      !("start" in workload) ||
      typeof workload.start !== "function" ||
      !("stop" in workload) ||
      typeof workload.stop !== "function" ||
      ("completion" in workload &&
        (typeof workload.completion !== "object" ||
          workload.completion === null ||
          !("then" in workload.completion) ||
          typeof workload.completion.then !== "function"))
    )
      throw new Error("invalid workload");
    return { workload: workload as WorkerWorkload };
  } catch {
    throw new Error("WORKER_CONFIGURATION_UNAVAILABLE");
  }
}
