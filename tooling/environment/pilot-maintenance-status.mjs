import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { pathToFileURL } from "node:url";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
const fail = () => {
  throw Error("PILOT_MAINTENANCE_STATUS_UNAVAILABLE");
};
export async function readPilotMaintenanceStatus(runtimeDirectory) {
  const directory = path.resolve(parsePilotRuntimeDirectory(runtimeDirectory));
  const dir = await fs.lstat(directory);
  if (
    process.platform !== "linux" ||
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== process.getuid() ||
    (dir.mode & 0o077) !== 0 ||
    (await fs.realpath(directory)) !== directory
  )
    return fail();
  const file = path.join(directory, "maintenance.lock");
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (e) {
    if (e.code === "ENOENT") return { state: "NoMaintenanceLease" };
    throw e;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 1024
  )
    return fail();
  const value = await fs.readFile(file, "utf8"),
    lease = JSON.parse(value);
  if (
    !Number.isSafeInteger(lease.pid) ||
    lease.pid < 1 ||
    !/^\d+$/.test(lease.started) ||
    !/^[0-9a-f-]{36}$/.test(lease.bootId) ||
    !["Stop", "Recovery", "Unspecified"].includes(lease.operation) ||
    typeof lease.startedAt !== "string" ||
    new Date(lease.startedAt).toISOString() !== lease.startedAt
  )
    return fail();
  let state = "OwnerExitedReviewRequired";
  const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (lease.bootId === bootId) {
    let proc;
    try {
      proc = await fs.readFile(`/proc/${lease.pid}/stat`, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (proc) {
      const fields = proc
        .slice(proc.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      if (fields[19] !== lease.started) state = "OwnerIdentityChangedReviewRequired";
      else if (!["Z", "X", "x"].includes(fields[0])) state = "OwnerActive";
    }
  }
  const current = await fs.lstat(file);
  if (
    current.dev !== stat.dev ||
    current.ino !== stat.ino ||
    (await fs.readFile(file, "utf8")) !== value
  )
    return fail();
  return { state, operation: lease.operation, startedAt: lease.startedAt, lockRetained: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) fail();
    console.log(JSON.stringify(await readPilotMaintenanceStatus(process.argv[2])));
  } catch {
    console.error("PILOT_MAINTENANCE_STATUS_UNAVAILABLE");
    process.exitCode = 1;
  }
}
