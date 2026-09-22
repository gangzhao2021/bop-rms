import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { parsePilotRecoveryArguments } from "./pilot-recovery-plan.mjs";
import { inspectPilotRecoveryScope } from "./pilot-recovery-review.mjs";
import { readPilotMaintenanceStatus } from "./pilot-maintenance-status.mjs";
import {
  readPilotResumeOwner,
  writePilotResumeOwner,
  assertPilotResumeOwner,
  snapshotPilotResumeFile,
  assertPilotResumeDirectory,
} from "./pilot-recovery-resume-owner.mjs";
const fail = () => {
  throw Error("PILOT_RESUME_TAKEOVER_REVIEW_REQUIRED");
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function syncDirectory(file) {
  const h = await fs.open(file, "r");
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
/** Explicit takeover preparation; never deletes prior evidence or releases maintenance. */
export async function preparePilotResumeTakeover(args) {
  if (process.env.NODE_ENV !== "development") fail();
  const plan = parsePilotRecoveryArguments(args),
    root = path.resolve(plan.runtimeDirectory);
  await assertPilotResumeDirectory(root);
  const guard = path.join(root, "recovery-resume-takeover.lock");
  await fs.mkdir(guard, { mode: 0o700 });
  const guardIdentity = await assertPilotResumeDirectory(guard);
  const assertGuard = async () => {
    const current = await assertPilotResumeDirectory(guard);
    if (current.ino !== guardIdentity.ino || current.dev !== guardIdentity.dev) fail();
  };
  const releaseGuard = async () => {
    await assertGuard();
    await fs.rmdir(guard);
  };
  try {
    const observed = await readPilotResumeOwner(plan.runtimeDirectory);
    if (
      observed.state !== "OwnerExitedReviewRequired" ||
      observed.label !== plan.label ||
      observed.maintenanceLease !== "OriginalPresent"
    )
      fail();
    const control = path.join(root, "recovery-resume.lock"),
      controlIdentity = await assertPilotResumeDirectory(control);
    const prior = await snapshotPilotResumeFile(path.join(control, "owner.json"));
    const lease = await snapshotPilotResumeFile(path.join(root, "maintenance.lock"));
    const scope = await inspectPilotRecoveryScope(args);
    const baseline = await snapshotPilotResumeFile(
      path.join(scope.folder, "source-baseline.json"),
      1048576,
    );
    const scopeIdentity = await assertPilotResumeDirectory(scope.folder);
    let attemptIdentity, attemptFolder;
    // Baseline can be larger than an owner record; scope inspection already limits it.
    if (
      !baseline.bytes.equals(scope.baselineBytes) ||
      digest(lease.bytes) !== scope.baseline.leaseSha256 ||
      JSON.parse(prior.bytes).leaseSha256 !== scope.baseline.leaseSha256
    )
      fail();
    async function unchanged(owner = prior) {
      await assertGuard();
      const scopeCurrent = await assertPilotResumeDirectory(scope.folder);
      if (scopeCurrent.ino !== scopeIdentity.ino || scopeCurrent.dev !== scopeIdentity.dev) fail();
      if (attemptIdentity) {
        const currentAttempt = await assertPilotResumeDirectory(attemptFolder);
        if (
          currentAttempt.ino !== attemptIdentity.ino ||
          currentAttempt.dev !== attemptIdentity.dev
        )
          fail();
      }
      const current = await assertPilotResumeDirectory(control);
      if (current.ino !== controlIdentity.ino || current.dev !== controlIdentity.dev) fail();
      await assertPilotResumeOwner(owner);
      await assertPilotResumeOwner(lease);
      await assertPilotResumeOwner(baseline);
      const maintenance = await readPilotMaintenanceStatus(plan.runtimeDirectory);
      if (maintenance.state !== "OwnerExitedReviewRequired" || maintenance.operation !== "Recovery")
        fail();
      for (const name of [
        "supervisor.lock",
        "supervisor-control.lock",
        "maintenance-clear-stop.lock",
      ]) {
        try {
          await fs.lstat(path.join(root, name));
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        fail();
      }
    }
    await unchanged();
    const confirmed = await readPilotResumeOwner(plan.runtimeDirectory);
    if (JSON.stringify(confirmed) !== JSON.stringify(observed)) fail();
    await assertPilotResumeOwner(prior);
    const attempt = "resume-attempt-" + randomUUID(),
      folder = path.join(scope.folder, attempt);
    await fs.mkdir(folder, { mode: 0o700 });
    attemptFolder = folder;
    attemptIdentity = await assertPilotResumeDirectory(folder);
    await syncDirectory(scope.folder);
    await unchanged();
    // Keep the old inode and bytes; the containing control remains exclusive throughout.
    await fs.rename(prior.file, path.join(folder, "prior-owner.json"));
    await syncDirectory(folder);
    await syncDirectory(control);
    const owner = await writePilotResumeOwner(
      control,
      plan.label,
      scope.baseline.leaseSha256,
      attempt,
    );
    await unchanged(owner);
    return { owner, folder, assertUnchanged: () => unchanged(owner), releaseGuard };
  } catch (error) {
    await releaseGuard();
    throw error;
  }
}
