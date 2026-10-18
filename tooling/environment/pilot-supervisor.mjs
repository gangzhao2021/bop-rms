import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createPilotRecoverySweep } from "./pilot-recovery-sweep.mjs";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { assertPilotReady, isPilotRuntime } from "./pilot-environment.mjs";
import { SUPERVISOR_HEALTH_FILE, writePrivateJson } from "./pilot-ops-files.mjs";
export async function acquirePilotSupervisorLease(runtimeDirectory) {
  const root = await fs.realpath(process.cwd());
  const directory = path.join(root, parsePilotRuntimeDirectory(runtimeDirectory));
  const stat = await fs.lstat(directory);
  if (
    process.platform !== "linux" ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    (await fs.realpath(directory)) !== directory
  )
    throw Error("PILOT_SUPERVISOR_DIRECTORY_INVALID");
  const file = path.join(directory, "supervisor.lock");
  const handle = await fs.open(file, "wx", 0o600);
  try {
    try {
      await fs.lstat(path.join(directory, "maintenance.lock"));
      throw Error("PILOT_MAINTENANCE_IN_PROGRESS");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const service of [
      "api",
      "customer",
      "business-worker",
      "kitchen-queue-worker",
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
    ]) {
      try {
        await fs.lstat(path.join(directory, `${service}.restart-lock`));
        throw Error("PILOT_MAINTENANCE_IN_PROGRESS");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const selfStat = await fs.readFile("/proc/self/stat", "utf8");
    const started = selfStat
      .slice(selfStat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u)[19];
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, started, startedAt: new Date().toISOString() }) + "\n",
    );
  } catch (error) {
    await handle.close();
    await fs.unlink(file);
    throw error;
  }
  const owned = await handle.stat();
  let released = false;
  return async () => {
    if (released) return;
    const current = await fs.lstat(file);
    if (current.dev !== owned.dev || current.ino !== owned.ino)
      throw Error("PILOT_SUPERVISOR_LEASE_CHANGED");
    await fs.unlink(file);
    await handle.close();
    released = true;
  };
}
/** Which optional business workloads report health, from the installed worker configuration. */
export function createPilotWorkloadHealthOptions(
  runtimeDirectory,
  read = (file) => fs.readFile(file, "utf8"),
) {
  const directory = parsePilotRuntimeDirectory(runtimeDirectory);
  return async (service) => {
    if (service !== "business-worker") return {};
    const config = JSON.parse(await read(path.join(directory, "business-worker.json")));
    return {
      requireBatchCancellation: config?.workloads?.batchCancellation === true,
      requireCompensation: config?.workloads?.compensation === true,
    };
  };
}
/** WP-2423 pilot resilience: one alert line whenever the set of services or workloads needing a
 * person changes (names only), besides the full snapshot on every sweep. */
export function createPilotAttentionReporter(write = (line) => process.stderr.write(line)) {
  let previous = "[]";
  return (snapshot) => {
    const needs = snapshot.services
      .flatMap((entry) => [
        ...(entry.state === "attention_required" ? [entry.service] : []),
        ...(entry.attention ?? []).map((component) => entry.service + ":" + component),
      ])
      .sort();
    const current = JSON.stringify(needs);
    if (current === previous) return;
    previous = current;
    write(
      JSON.stringify({
        level: needs.length > 0 ? 50 : 30,
        time: snapshot.observedAt,
        event: needs.length > 0 ? "pilot_attention_required" : "pilot_attention_cleared",
        attention: needs,
      }) + "\n",
    );
  };
}
/** WP-2423 Q13: the latest sweep as a private file, so the separate operations monitor can alert
 * on services needing a person and notice when the supervisor itself stops (names and states only). */
export function createPilotSupervisorHealthWriter(
  runtimeDirectory,
  write = writePrivateJson,
  report = (line) => process.stderr.write(line),
) {
  const file = path.join(parsePilotRuntimeDirectory(runtimeDirectory), SUPERVISOR_HEALTH_FILE);
  return async (snapshot) => {
    try {
      await write(file, {
        schemaVersion: 1,
        observedAt: snapshot.observedAt,
        services: snapshot.services.map((entry) => ({
          service: entry.service,
          state: entry.state,
          ...(entry.attention ? { attention: [...entry.attention] } : {}),
        })),
      });
    } catch {
      // Reporting must never stop supervision; the monitor alerts on a stale file instead.
      report("PILOT_SUPERVISOR_HEALTH_WRITE_UNAVAILABLE\n");
    }
  };
}
export async function runPilotSupervisor({
  runtimeDirectory,
  signal,
  acquire = acquirePilotSupervisorLease,
  sweep = createPilotRecoverySweep({
    runtimeDirectory,
    workloadHealth: createPilotWorkloadHealthOptions(runtimeDirectory),
  }),
  wait = delay,
  observe = () => undefined,
}) {
  parsePilotRuntimeDirectory(runtimeDirectory);
  if (!signal || typeof signal.aborted !== "boolean")
    throw Error("PILOT_SUPERVISOR_SIGNAL_REQUIRED");
  if (signal.aborted) return;
  const release = await acquire(runtimeDirectory);
  try {
    while (!signal.aborted) {
      const services = await sweep.sweep({ signal });
      if (signal.aborted) break;
      await observe({ observedAt: new Date().toISOString(), services });
      try {
        await wait(5000, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  } finally {
    await release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new globalThis.AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (process.argv.length !== 3 || !isPilotRuntime())
      throw Error("PILOT_SUPERVISOR_ARGUMENT_INVALID");
    try {
      assertPilotReady();
    } catch (error) {
      // WP-2423 P1b: name what a Pilot Store still lacks (capability codes only, no data).
      console.error(
        String(error?.message).startsWith("PILOT_CAPABILITY_MISSING:")
          ? error.message
          : "PILOT_ENVIRONMENT_INVALID",
      );
      throw error;
    }
    await runPilotSupervisor({
      runtimeDirectory: process.argv[2],
      signal: controller.signal,
      observe: (() => {
        const report = createPilotAttentionReporter();
        const health = createPilotSupervisorHealthWriter(process.argv[2]);
        return async (snapshot) => {
          console.log(JSON.stringify(snapshot));
          report(snapshot);
          await health(snapshot);
        };
      })(),
    });
  } catch {
    console.error("PILOT_SUPERVISOR_UNAVAILABLE");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
