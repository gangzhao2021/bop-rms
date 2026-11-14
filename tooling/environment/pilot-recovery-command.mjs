import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  assertPilotRecoveryMaintenance,
  retainPilotRecoveryMaintenance,
} from "./pilot-maintenance.mjs";
export async function runPilotRecoveryCommand({
  runtimeDirectory,
  folder,
  phase,
  args,
  stdio,
  execute = spawnSync,
}) {
  assertPilotRecoveryMaintenance(runtimeDirectory);
  if (!["Dump", "Restore"].includes(phase)) throw Error("RECOVERY_PHASE_INVALID");
  const directory = await assertPilotRecoveryDirectory(runtimeDirectory, folder);
  async function checkpoint(state) {
    const handle = await open(
      path.join(directory, phase.toLowerCase() + "-" + state.toLowerCase() + ".json"),
      "wx",
      0o600,
    );
    try {
      await handle.writeFile(
        JSON.stringify({ schemaVersion: 1, phase, state, recordedAt: new Date().toISOString() }) +
          "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  try {
    await checkpoint("Started");
    const result = execute("docker", args, { stdio, timeout: 120000 });
    if (result?.error || result?.status !== 0) throw Error("RECOVERY_COMMAND_UNCERTAIN");
    await checkpoint("Completed");
  } catch {
    retainPilotRecoveryMaintenance(runtimeDirectory);
    throw Error("RECOVERY_COMMAND_REVIEW_REQUIRED");
  }
}

export async function assertPilotRecoveryDirectory(runtimeDirectory, folder) {
  const directory = path.resolve(folder),
    stat = await lstat(directory);
  if (
    path.dirname(directory) !== path.resolve(runtimeDirectory) ||
    !/^recovery-[a-z0-9][a-z0-9-]{0,47}$/u.test(path.basename(directory)) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== directory
  )
    throw Error("RECOVERY_PHASE_DIRECTORY_INVALID");
  return directory;
}
