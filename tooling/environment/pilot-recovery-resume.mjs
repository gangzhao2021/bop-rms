import { preparePilotResumeTakeover } from "./pilot-recovery-resume-takeover.mjs";
import {
  writePilotResumeOwner,
  assertPilotResumeOwner,
  removePilotResumeOwner,
} from "./pilot-recovery-resume-owner.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parsePilotRecoveryArguments } from "./pilot-recovery-plan.mjs";
import {
  reviewPilotRecovery,
  readPilotRecoveryPrivateFile as privateRead,
} from "./pilot-recovery-review.mjs";
import { withPilotRecoveryResumeAccess } from "./pilot-maintenance.mjs";
import { startPilotRuntime } from "./pilot-start.mjs";
import { runPilotService } from "./pilot-service.mjs";
import { isPilotRuntime } from "./pilot-environment.mjs";
const fail = () => {
  throw Error("PILOT_RECOVERY_RESUME_REVIEW_REQUIRED");
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function resumePilotRecoverySource(args, { takeover = false } = {}) {
  if (!isPilotRuntime()) fail();
  const plan = parsePilotRecoveryArguments(args),
    directory = path.resolve(plan.runtimeDirectory),
    folder = path.join(directory, plan.label);
  const st = await fs.lstat(directory);
  if (
    (await fs.realpath(directory)) !== directory ||
    !st.isDirectory() ||
    st.uid !== process.getuid() ||
    (st.mode & 0o077) !== 0
  )
    fail();
  const control = path.join(directory, "recovery-resume.lock");
  const adopted = takeover ? await preparePilotResumeTakeover(args) : null;
  if (!adopted) await fs.mkdir(control, { mode: 0o700 });
  const attemptFolder = adopted?.folder ?? folder;
  let completed = false;
  const controlIdentity = await fs.lstat(control);
  const leaseFile = path.join(directory, "maintenance.lock"),
    baselineFile = path.join(folder, "source-baseline.json");
  let recordedOwner;
  try {
    const identity = await fs.lstat(leaseFile),
      content = await privateRead(leaseFile, 1024),
      baselineBytes = await privateRead(baselineFile);
    recordedOwner =
      adopted?.owner ?? (await writePilotResumeOwner(control, plan.label, hash(content)));
    if (adopted) {
      await withPilotRecoveryResumeAccess(plan.runtimeDirectory, async () => {
        let failed = false;
        for (const name of [
          "customer",
          "api",
          "business-worker",
          "kitchen-queue-worker",
          "reconciliation-worker",
          "daily-settlement-worker",
          "dining-exception-worker",
        ]) {
          try {
            await adopted.assertUnchanged();
            await runPilotService("stop", name, plan.runtimeDirectory);
          } catch {
            failed = true;
          }
        }
        if (failed) fail();
      });
    }
    const result = await reviewPilotRecovery(args);
    if (result.state !== "SourceComparisonMatchedReviewRequired") fail();
    const baseline = JSON.parse(baselineBytes);
    if (hash(content) !== baseline.leaseSha256) fail();
    const flags = baseline.requiredFeatures;
    if (
      !flags ||
      flags.diningExceptionProjection !== true ||
      ["reconciliationProjection", "dailySettlement", "batchCancellation", "compensation"].some(
        (key) => typeof flags[key] !== "boolean",
      )
    )
      fail();
    const unchanged = async () => {
      await assertPilotResumeOwner(recordedOwner);
      if (adopted) await adopted.assertUnchanged();
      const current = await fs.lstat(leaseFile),
        owner = await fs.lstat(control);
      if (
        current.ino !== identity.ino ||
        current.dev !== identity.dev ||
        owner.ino !== controlIdentity.ino ||
        owner.dev !== controlIdentity.dev ||
        !(await privateRead(leaseFile, 1024)).equals(content) ||
        !(await privateRead(baselineFile)).equals(baselineBytes)
      )
        fail();
    };
    const checkpoint = async (state) => {
      await unchanged();
      const file = await fs.open(
        path.join(attemptFolder, "source-resume-" + state.toLowerCase() + ".json"),
        "wx",
        0o600,
      );
      try {
        await file.writeFile(
          JSON.stringify({
            schemaVersion: 1,
            state,
            recordedAt: new Date().toISOString(),
            leaseSha256: baseline.leaseSha256,
            originalLease: JSON.parse(content.toString()),
            targetRestorationVerified: false,
          }) + "\n",
        );
        await file.sync();
      } finally {
        await file.close();
      }
      const parent = await fs.open(attemptFolder, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    };
    await unchanged();
    for (const name of ["source-resume-started.json", "source-resume-completed.json"]) {
      try {
        await fs.lstat(path.join(attemptFolder, name));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      fail();
    }
    await withPilotRecoveryResumeAccess(plan.runtimeDirectory, async () => {
      await checkpoint("Started");
      const service = async (...parameters) => {
        await unchanged();
        return runPilotService(...parameters);
      };
      try {
        const started = await startPilotRuntime({
          runtimeDirectory: plan.runtimeDirectory,
          service,
          requireDiningExceptionProjection: flags.diningExceptionProjection,
          requireReconciliationProjection: flags.reconciliationProjection,
          requireDailySettlement: flags.dailySettlement,
          requireBatchCancellation: flags.batchCancellation,
          requireCompensation: flags.compensation,
        });
        if (started.state !== "started") fail();
        await checkpoint("Completed");
        await unchanged();
        await fs.unlink(leaseFile);
        completed = true;
      } catch {
        // Attempt every service; uncertainty retains the original Recovery lease.
        for (const name of [
          "customer",
          "api",
          "business-worker",
          "kitchen-queue-worker",
          "reconciliation-worker",
          "daily-settlement-worker",
          "dining-exception-worker",
        ]) {
          try {
            await service("stop", name, plan.runtimeDirectory);
          } catch {
            /* Retain exclusion. */
          }
        }
        fail();
      }
    });
    return {
      state: "SourceResumed",
      maintenanceReleased: true,
      targetRestorationVerified: false,
      targetPromoted: false,
      supervisorStarted: false,
    };
  } finally {
    const current = await fs.lstat(control);
    if (current.ino !== controlIdentity.ino || current.dev !== controlIdentity.dev) fail();
    try {
      if (!adopted || completed) {
        if (recordedOwner) await removePilotResumeOwner(recordedOwner);
        await fs.rmdir(control);
      }
    } finally {
      if (adopted) await adopted.releaseGuard();
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (
      ![6, 7].includes(process.argv.length) ||
      (process.argv.length === 7 && process.argv[6] !== "--resume-interrupted")
    )
      fail();
    console.log(
      JSON.stringify(
        await resumePilotRecoverySource(process.argv.slice(2, 6), {
          takeover: process.argv[6] === "--resume-interrupted",
        }),
      ),
    );
  } catch {
    console.error("PILOT_RECOVERY_RESUME_REVIEW_REQUIRED");
    process.exitCode = 1;
  }
}
