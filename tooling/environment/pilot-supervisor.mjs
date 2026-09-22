import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createPilotRecoverySweep } from "./pilot-recovery-sweep.mjs";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
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
export async function runPilotSupervisor({
  runtimeDirectory,
  signal,
  acquire = acquirePilotSupervisorLease,
  sweep = createPilotRecoverySweep({ runtimeDirectory }),
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
    if (process.argv.length !== 3 || process.env.NODE_ENV !== "development")
      throw Error("PILOT_SUPERVISOR_ARGUMENT_INVALID");
    await runPilotSupervisor({
      runtimeDirectory: process.argv[2],
      signal: controller.signal,
      observe: (snapshot) => console.log(JSON.stringify(snapshot)),
    });
  } catch {
    console.error("PILOT_SUPERVISOR_UNAVAILABLE");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
