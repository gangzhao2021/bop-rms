import { isAbsolute, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { ApiServerRuntime } from "./server.js";

/** Trusted executable configuration; returned shutdown owns configured resources. */
export async function loadApiProcessConfiguration(
  args: readonly string[],
  port: number,
): Promise<ApiServerRuntime | undefined> {
  if (args.length === 0) return undefined;
  if (
    args.length !== 2 ||
    args[0] !== "--configuration" ||
    !args[1] ||
    !isAbsolute(args[1]) ||
    ![".js", ".mjs"].includes(extname(args[1]))
  )
    throw new Error("API_CONFIGURATION_INVALID");
  try {
    const module: unknown = await import(pathToFileURL(args[1]).href);
    if (
      typeof module !== "object" ||
      module === null ||
      !("createRuntime" in module) ||
      typeof module.createRuntime !== "function"
    )
      throw new Error("invalid module");
    const runtime: unknown = await module.createRuntime({ port });
    if (
      typeof runtime !== "object" ||
      runtime === null ||
      !("listen" in runtime) ||
      typeof runtime.listen !== "function" ||
      !("shutdown" in runtime) ||
      typeof runtime.shutdown !== "function" ||
      !("server" in runtime) ||
      !("healthReadiness" in runtime)
    )
      throw new Error("invalid runtime");
    return runtime as ApiServerRuntime;
  } catch {
    throw new Error("API_CONFIGURATION_UNAVAILABLE");
  }
}
