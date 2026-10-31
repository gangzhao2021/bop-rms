import { pilotHealthComponents } from "./pilot-workload-health.mjs";
import {
  runPilotService,
  pilotRuntimeDirectory,
  parsePilotRuntimeDirectory,
} from "./pilot-service.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import console from "node:console";
async function apiReady() {
  const response = await globalThis.fetch("http://127.0.0.1:4300/ready", {
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(1500),
  });
  if (response.status !== 200) return false;
  const body = await response.text();
  if (body.length > 4096) return false;
  const value = JSON.parse(body);
  return (
    value.service === "bop-rms-api" &&
    value.status === "ready" &&
    value.dependencies?.database?.required === true &&
    value.dependencies.database.status === "ready"
  );
}
export async function customerReady(runtimeDirectory = pilotRuntimeDirectory) {
  runtimeDirectory = parsePilotRuntimeDirectory(runtimeDirectory);
  const ca = await readFile(path.resolve(runtimeDirectory, "customer-tls-cert.pem"));
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        hostname: "127.0.0.1",
        port: 4443,
        path: "/app",
        ca,
        rejectUnauthorized: true,
        timeout: 1500,
      },
      (response) => {
        const ok =
          response.statusCode === 200 && response.headers["content-type"]?.startsWith("text/html");
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 65536) response.destroy(new Error("PILOT_RESPONSE_INVALID"));
        });
        response.once("end", () => resolve(Boolean(ok)));
        response.once("error", reject);
      },
    );
    request.once("timeout", () => request.destroy(new Error("PILOT_RESPONSE_TIMEOUT")));
    request.once("error", reject);
  });
}
const cycleObserved = (value) =>
  value?.state === "running" &&
  Number.isSafeInteger(value.completedCycles) &&
  value.completedCycles > 0 &&
  typeof value.lastCycleCompletedAt === "string";
export async function startPilotRuntime({
  runtimeDirectory = pilotRuntimeDirectory,
  requireBatchCancellation = false,
  requireCompensation = false,
  requireReconciliationProjection = false,
  requireDailySettlement = false,
  requireDiningExceptionProjection = false,
  service = runPilotService,
  api = apiReady,
  customer = customerReady,
  wait = delay,
} = {}) {
  runtimeDirectory = parsePilotRuntimeDirectory(runtimeDirectory);
  const completed = [];
  let stage = "api";
  const observe = async (probe) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        if ((await probe()) === true) return true;
      } catch {
        /* Observe the same process during startup; never restart here. */
      }
      if (attempt < 19) await wait(500);
    }
    return false;
  };
  try {
    for (const name of [
      "api",
      "business-worker",
      "kitchen-queue-worker",
      ...(requireReconciliationProjection ? ["reconciliation-worker"] : []),
      ...(requireDailySettlement ? ["daily-settlement-worker"] : []),
      ...(requireDiningExceptionProjection ? ["dining-exception-worker"] : []),
      "customer",
    ]) {
      stage = name;
      const started = await service("start", name, runtimeDirectory);
      const probe =
        name === "api"
          ? api
          : name === "customer"
            ? () => customer(runtimeDirectory)
            : async () => {
                const health = await service("health", name, runtimeDirectory, {
                  requireBatchCancellation,
                  requireCompensation,
                });
                if (health.pid !== started.pid) return false;
                return name === "business-worker"
                  ? Object.keys(
                      pilotHealthComponents(name, {
                        requireBatchCancellation,
                        requireCompensation,
                      }),
                    ).every(
                      (component) =>
                        cycleObserved(health.workloads?.[component]) &&
                        (!["batchCancellation", "compensation"].includes(component) ||
                          [
                            health.workloads[component].reportAgeMs,
                            health.workloads[component].lastCompletionAgeMs,
                          ].every((age) => Number.isFinite(age) && age >= 0 && age <= 35000)),
                    )
                  : cycleObserved(health) &&
                      (![
                        "reconciliation-worker",
                        "dining-exception-worker",
                        "daily-settlement-worker",
                      ].includes(name) ||
                        [health.reportAgeMs, health.lastCompletionAgeMs].every(
                          (age) => Number.isFinite(age) && age >= 0 && age <= 35000,
                        ));
              };
      if (!(await observe(probe)))
        return {
          state: "incomplete",
          stage,
          completed,
          code: "PILOT_STARTUP_OBSERVATION_UNAVAILABLE",
        };
      const current = await service("status", name, runtimeDirectory);
      if (current.pid !== started.pid) throw new Error("PILOT_PROCESS_CHANGED");
      completed.push({ service: name, pid: current.pid, state: started.state });
    }
    return { state: "started", services: completed };
  } catch {
    return { state: "incomplete", stage, completed, code: "PILOT_STARTUP_UNAVAILABLE" };
  }
}
export function parsePilotStartArguments(args) {
  if (!Array.isArray(args) || args.length > 6 || args.some((value) => typeof value !== "string"))
    throw new Error("PILOT_STARTUP_ARGUMENT_INVALID");
  const [directory, ...flags] = args;
  if (
    new Set(flags).size !== flags.length ||
    flags.some(
      (value) =>
        ![
          "--require-batch-cancellation",
          "--require-compensation",
          "--require-reconciliation-projection",
          "--require-daily-settlement",
          "--require-dining-exception-projection",
        ].includes(value),
    )
  )
    throw new Error("PILOT_STARTUP_ARGUMENT_INVALID");
  return {
    runtimeDirectory: parsePilotRuntimeDirectory(directory ?? pilotRuntimeDirectory),
    requireBatchCancellation: flags.includes("--require-batch-cancellation"),
    requireCompensation: flags.includes("--require-compensation"),
    ...(flags.includes("--require-dining-exception-projection")
      ? { requireDiningExceptionProjection: true }
      : {}),
    ...(flags.includes("--require-daily-settlement") ? { requireDailySettlement: true } : {}),
    ...(flags.includes("--require-reconciliation-projection")
      ? { requireReconciliationProjection: true }
      : {}),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await startPilotRuntime(parsePilotStartArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if (result.state !== "started") process.exitCode = 1;
  } catch {
    console.error("PILOT_STARTUP_ARGUMENT_INVALID");
    process.exitCode = 1;
  }
}
