import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { pathToFileURL } from "node:url";
import { withPilotStopRecoveryAccess } from "./pilot-maintenance.mjs";
import { readPilotMaintenanceStatus } from "./pilot-maintenance-status.mjs";
import {
  confirmPilotServiceStopped,
  runPilotService,
  parsePilotRuntimeDirectory,
} from "./pilot-service.mjs";
import { isPilotRuntime } from "./pilot-environment.mjs";
const fail = () => {
  throw Error("PILOT_MAINTENANCE_CLEAR_STOP_UNAVAILABLE");
};
const services = [
  "customer",
  "api",
  "business-worker",
  "kitchen-queue-worker",
  "reconciliation-worker",
  "daily-settlement-worker",
  "dining-exception-worker",
];
export async function clearStoppedPilotMaintenance(
  runtimeDirectory,
  {
    confirmStopped = confirmPilotServiceStopped,
    finishStop = false,
    stopService = runPilotService,
  } = {},
) {
  runtimeDirectory = parsePilotRuntimeDirectory(runtimeDirectory);
  const root = await fs.realpath(process.cwd()),
    directory = path.join(root, runtimeDirectory);
  const eligible = async () => {
    const status = await readPilotMaintenanceStatus(runtimeDirectory);
    if (status.state !== "OwnerExitedReviewRequired" || status.operation !== "Stop") fail();
  };
  await eligible();
  const control = path.join(directory, "maintenance-clear-stop.lock");
  await fs.mkdir(control, { mode: 0o700 });
  const controlIdentity = await fs.lstat(control);
  try {
    await eligible();
    const file = path.join(directory, "maintenance.lock"),
      identity = await fs.lstat(file),
      content = await fs.readFile(file, "utf8");
    const unchanged = async () => {
      await eligible();
      const current = await fs.lstat(file);
      if (
        current.ino !== identity.ino ||
        current.dev !== identity.dev ||
        (await fs.readFile(file, "utf8")) !== content
      )
        fail();
      for (const name of [
        "supervisor.lock",
        "supervisor-control.lock",
        ...services.map((name) => name + ".restart-lock"),
      ]) {
        try {
          await fs.lstat(path.join(directory, name));
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        fail();
      }
    };
    await unchanged();
    if (finishStop) {
      await withPilotStopRecoveryAccess(runtimeDirectory, async () => {
        for (const service of services) {
          await unchanged();
          const result = await stopService("stop", service, runtimeDirectory);
          if (result?.service !== service || result.state !== "stopped") fail();
        }
      });
    }
    for (const service of services) {
      const pidFile = path.join(directory, service + ".pid");
      let pid = null;
      try {
        const stat = await fs.lstat(pidFile);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid() ||
          (stat.mode & 0o077) !== 0 ||
          stat.size > 32
        )
          fail();
        const raw = (await fs.readFile(pidFile, "utf8")).trim();
        if (!/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(Number(raw))) fail();
        pid = Number(raw);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if ((await confirmStopped({ root, service, pid, runtimeDirectory })) !== true) fail();
    }
    await unchanged();
    await fs.unlink(file);
    return {
      state: "StoppedMaintenanceReleased",
      servicesConfirmedStopped: services.length,
      servicesStarted: false,
    };
  } finally {
    const current = await fs.lstat(control);
    if (current.ino !== controlIdentity.ino || current.dev !== controlIdentity.dev) fail();
    await fs.rmdir(control);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (
      !isPilotRuntime() ||
      !(
        process.argv.length === 3 ||
        (process.argv.length === 4 && process.argv[3] === "--finish-stop")
      )
    )
      fail();
    console.log(
      JSON.stringify(
        await clearStoppedPilotMaintenance(process.argv[2], {
          finishStop: process.argv[3] === "--finish-stop",
        }),
      ),
    );
  } catch {
    console.error("PILOT_MAINTENANCE_CLEAR_STOP_UNAVAILABLE");
    process.exitCode = 1;
  }
}
