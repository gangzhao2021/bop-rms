import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const ownership = new AsyncLocalStorage();
const fail = () => {
  throw Error("PILOT_MAINTENANCE_ACTIVE");
};
/**
 * The installation directory a runtime directory's window belongs to. DEC-BRAND-MULTI-STORE (v15
 * 2026-10-31): a served Store's directory (`.local/<name>/stores/<store>`) has no window of its
 * own; a planned update window covers the whole installation, its Stores' workers included.
 */
function target(runtimeDirectory) {
  const match =
    typeof runtimeDirectory === "string"
      ? /^(\.local\/[a-z0-9][a-z0-9_-]{0,63})(?:\/stores\/[a-z0-9][a-z0-9-]{0,62})?$/u.exec(
          runtimeDirectory,
        )
      : null;
  if (match === null) return fail();
  return path.resolve(match[1]);
}
/** The served Stores' directories below an installation (`stores.json`; none when absent). */
async function storeDirectories(directory) {
  let text;
  try {
    text = await fs.readFile(path.join(directory, "stores.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const stores = JSON.parse(text)?.stores;
  if (
    !Array.isArray(stores) ||
    stores.some(
      (entry) => typeof entry !== "string" || !/^stores\/[a-z0-9][a-z0-9-]{0,62}$/u.test(entry),
    )
  )
    return fail();
  return stores.map((entry) => path.join(directory, entry));
}
export async function assertPilotMaintenanceAccess(runtimeDirectory, action) {
  const directory = target(runtimeDirectory);
  if (ownership.getStore()?.directory === directory && ownership.getStore().active) {
    if (
      ownership.getStore().retain ||
      (ownership.getStore().stopOnly && action !== "stop") ||
      (ownership.getStore().resumeOnly && !["start", "stop"].includes(action))
    )
      return fail();
    return;
  }
  try {
    await fs.lstat(path.join(directory, "maintenance.lock"));
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  return fail();
}
export async function withPilotMaintenance(runtimeDirectory, work, operation = "Unspecified") {
  if (!["Stop", "Recovery", "Unspecified"].includes(operation)) return fail();
  const directory = target(runtimeDirectory),
    owner = ownership.getStore();
  if (owner?.directory === directory && owner.active) {
    if (owner.stopOnly || owner.resumeOnly || owner.retain) return fail();
    return work();
  }
  const stat = await fs.lstat(directory);
  if (
    process.platform !== "linux" ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    (await fs.realpath(directory)) !== directory
  )
    return fail();
  const file = path.join(directory, "maintenance.lock"),
    handle = await fs.open(file, "wx", 0o600),
    identity = await handle.stat();
  const context = { directory, active: true, operation, retain: false };
  try {
    const workers = [
      "business-worker",
      "kitchen-queue-worker",
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
    ].map((v) => v + ".restart-lock");
    const busy = [
      ...[
        "supervisor.lock",
        ...["api", "customer"].map((v) => v + ".restart-lock"),
        ...workers,
      ].map((name) => path.join(directory, name)),
      // A served Store's worker being started or stopped holds the window off too.
      ...(await storeDirectories(directory)).flatMap((store) =>
        workers.map((name) => path.join(store, name)),
      ),
    ];
    for (const file of busy) {
      try {
        await fs.lstat(file);
        return fail();
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        operation,
        bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
        started: (await fs.readFile(`/proc/${process.pid}/stat`, "utf8"))
          .split(") ")
          .at(-1)
          .trim()
          .split(/\s+/u)[19],
      }) + "\n",
    );
    return await ownership.run(context, work);
  } finally {
    context.active = false;
    try {
      const current = await fs.lstat(file);
      if (current.ino !== identity.ino || current.dev !== identity.dev) fail();
      if (!context.retain) await fs.unlink(file);
    } finally {
      await handle.close();
    }
  }
}

// Only the explicit stale-Stop recovery controller enters this context. It retains
// the original lease and owns the exclusive cleanup control for the entire call.
export async function withPilotStopRecoveryAccess(runtimeDirectory, work) {
  const directory = target(runtimeDirectory);
  const { readPilotMaintenanceStatus } = await import("./pilot-maintenance-status.mjs");
  const state = await readPilotMaintenanceStatus(runtimeDirectory);
  if (state.state !== "OwnerExitedReviewRequired" || state.operation !== "Stop") return fail();
  const control = await fs.lstat(path.join(directory, "maintenance-clear-stop.lock"));
  if (
    !control.isDirectory() ||
    control.isSymbolicLink() ||
    control.uid !== process.getuid() ||
    (control.mode & 0o077) !== 0
  )
    return fail();
  const context = { directory, active: true, stopOnly: true };
  try {
    return await ownership.run(context, work);
  } finally {
    context.active = false;
  }
}

function recoveryOwner(runtimeDirectory, allowRetained = false) {
  const owner = ownership.getStore();
  if (
    owner?.directory !== target(runtimeDirectory) ||
    !owner.active ||
    owner.operation !== "Recovery" ||
    owner.stopOnly ||
    (owner.retain && !allowRetained)
  )
    return fail();
  return owner;
}
export function assertPilotRecoveryMaintenance(runtimeDirectory) {
  recoveryOwner(runtimeDirectory);
}
export function retainPilotRecoveryMaintenance(runtimeDirectory) {
  recoveryOwner(runtimeDirectory, true).retain = true;
}

export async function withPilotRecoveryResumeAccess(runtimeDirectory, work) {
  const directory = target(runtimeDirectory);
  const { readPilotMaintenanceStatus } = await import("./pilot-maintenance-status.mjs");
  const state = await readPilotMaintenanceStatus(runtimeDirectory);
  if (state.state !== "OwnerExitedReviewRequired" || state.operation !== "Recovery") return fail();
  const control = await fs.lstat(path.join(directory, "recovery-resume.lock"));
  if (
    !control.isDirectory() ||
    control.isSymbolicLink() ||
    control.uid !== process.getuid() ||
    (control.mode & 0o077) !== 0
  )
    return fail();
  const context = { directory, active: true, resumeOnly: true };
  try {
    return await ownership.run(context, work);
  } finally {
    context.active = false;
  }
}
