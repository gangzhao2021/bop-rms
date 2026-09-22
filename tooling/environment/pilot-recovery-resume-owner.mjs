import fs from "node:fs/promises";
import { constants } from "node:fs";
import process from "node:process";
import path from "node:path";
import console from "node:console";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
const fail = () => {
  throw Error("PILOT_RESUME_OWNER_REVIEW_REQUIRED");
};
async function directory(file) {
  const stat = await fs.lstat(file);
  if (
    process.platform !== "linux" ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    (await fs.realpath(file)) !== file
  )
    fail();
  return stat;
}
async function snapshot(file, limit = 4096) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > limit ||
      stat.nlink !== 1
    )
      fail();
    const bytes = await handle.readFile();
    const current = await fs.lstat(file);
    if (current.ino !== stat.ino || current.dev !== stat.dev) fail();
    return { file, bytes, ino: stat.ino, dev: stat.dev, limit };
  } finally {
    await handle.close();
  }
}
export async function assertPilotResumeOwner(owner) {
  const current = await snapshot(owner.file, owner.limit);
  if (current.ino !== owner.ino || current.dev !== owner.dev || !current.bytes.equals(owner.bytes))
    fail();
}
export async function writePilotResumeOwner(control, label, leaseSha256, attempt) {
  await directory(control);
  if (!/^recovery-[a-z0-9][a-z0-9-]{0,47}$/.test(label) || !/^[a-f0-9]{64}$/.test(leaseSha256))
    fail();
  if (attempt !== undefined && !/^resume-attempt-[a-f0-9-]{36}$/.test(attempt)) fail();
  const proc = await fs.readFile(`/proc/${process.pid}/stat`, "utf8");
  const value = {
    schemaVersion: 1,
    pid: process.pid,
    started: proc
      .slice(proc.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u)[19],
    bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    label,
    leaseSha256,
    ...(attempt === undefined ? {} : { attempt }),
  };
  const file = path.join(control, "owner.json");
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const parent = await fs.open(control, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return snapshot(file);
}
export async function removePilotResumeOwner(owner) {
  await assertPilotResumeOwner(owner);
  await fs.unlink(owner.file);
}
async function attemptState(root, value) {
  const base = path.join(root, value.label);
  await directory(base);
  const folder = value.attempt === undefined ? base : path.join(base, value.attempt);
  const folderIdentity = await directory(folder);
  const retained = [];
  async function optional(file) {
    try {
      const saved = await snapshot(file);
      retained.push(saved);
      return saved;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  const started = await optional(path.join(folder, "source-resume-started.json"));
  const completed = await optional(path.join(folder, "source-resume-completed.json"));
  if (completed && !started) fail();
  for (const [saved, expected] of [
    [started, "Started"],
    [completed, "Completed"],
  ]) {
    if (!saved) continue;
    const record = JSON.parse(saved.bytes.toString());
    if (
      record.schemaVersion !== 1 ||
      record.state !== expected ||
      record.leaseSha256 !== value.leaseSha256 ||
      record.targetRestorationVerified !== false ||
      typeof record.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(record.recordedAt)) ||
      new Date(record.recordedAt).toISOString() !== record.recordedAt ||
      !record.originalLease ||
      typeof record.originalLease !== "object"
    )
      fail();
  }
  if (started && completed) {
    const first = JSON.parse(started.bytes.toString()),
      last = JSON.parse(completed.bytes.toString());
    if (
      first.recordedAt > last.recordedAt ||
      JSON.stringify(first.originalLease) !== JSON.stringify(last.originalLease)
    )
      fail();
  }
  const lease = await optional(path.join(root, "maintenance.lock"));
  if (lease && createHash("sha256").update(lease.bytes).digest("hex") !== value.leaseSha256) fail();
  if (!lease && !completed) fail();
  for (const saved of [started, completed]) {
    if (
      saved &&
      lease &&
      JSON.stringify(JSON.parse(saved.bytes.toString()).originalLease) !==
        JSON.stringify(JSON.parse(lease.bytes.toString()))
    )
      fail();
  }
  const assertUnchanged = async () => {
    const current = await directory(folder);
    if (current.ino !== folderIdentity.ino || current.dev !== folderIdentity.dev) fail();
    for (const saved of retained) await assertPilotResumeOwner(saved);
    for (const [saved, file] of [
      [started, path.join(folder, "source-resume-started.json")],
      [completed, path.join(folder, "source-resume-completed.json")],
      [lease, path.join(root, "maintenance.lock")],
    ]) {
      if (saved) continue;
      try {
        await fs.lstat(file);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      fail();
    }
  };
  await assertUnchanged();
  return {
    phase: completed
      ? "CompletionRecordedReviewRequired"
      : started
        ? "StartupInterruptedReviewRequired"
        : "BeforeStartupReviewRequired",
    maintenanceLease: lease ? "OriginalPresent" : "AbsentAfterCompletionRecord",
    assertUnchanged,
  };
}
/** Diagnosis only. Owner exit never authorizes deleting controls or starting services. */
export async function readPilotResumeOwner(runtimeDirectory) {
  const root = path.resolve(parsePilotRuntimeDirectory(runtimeDirectory));
  await directory(root);
  const control = path.join(root, "recovery-resume.lock");
  let original;
  try {
    original = await directory(control);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "NoResumeControl" };
    throw error;
  }
  let owner;
  try {
    owner = await snapshot(path.join(control, "owner.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const current = await directory(control);
    if (current.ino !== original.ino || current.dev !== original.dev) fail();
    return { state: "OwnerUnrecordedReviewRequired", controlRetained: true };
  }
  const value = JSON.parse(owner.bytes.toString());
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.started !== "string" ||
    !/^\d+$/.test(value.started) ||
    typeof value.bootId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.bootId) ||
    typeof value.label !== "string" ||
    !/^recovery-[a-z0-9][a-z0-9-]{0,47}$/.test(value.label) ||
    typeof value.leaseSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.leaseSha256)
  )
    fail();
  if (
    value.attempt !== undefined &&
    (typeof value.attempt !== "string" || !/^resume-attempt-[a-f0-9-]{36}$/.test(value.attempt))
  )
    fail();
  let state = "OwnerExitedReviewRequired";
  const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (boot === value.bootId) {
    let proc;
    try {
      proc = await fs.readFile(`/proc/${value.pid}/stat`, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (proc) {
      const fields = proc
        .slice(proc.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      if (fields[19] !== value.started) state = "OwnerIdentityChangedReviewRequired";
      else if (!["Z", "X", "x"].includes(fields[0])) state = "OwnerActive";
    }
  }
  const attempt = state === "OwnerExitedReviewRequired" ? await attemptState(root, value) : null;
  const current = await directory(control);
  if (current.ino !== original.ino || current.dev !== original.dev) fail();
  await assertPilotResumeOwner(owner);
  if (attempt) await attempt.assertUnchanged();
  return {
    state,
    label: value.label,
    controlRetained: true,
    ...(attempt ? { phase: attempt.phase, maintenanceLease: attempt.maintenanceLease } : {}),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) fail();
    console.log(JSON.stringify(await readPilotResumeOwner(process.argv[2])));
  } catch {
    console.error("PILOT_RESUME_OWNER_REVIEW_REQUIRED");
    process.exitCode = 1;
  }
}

export { snapshot as snapshotPilotResumeFile, directory as assertPilotResumeDirectory };
