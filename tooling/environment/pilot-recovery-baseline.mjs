import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { assertPilotRecoveryMaintenance } from "./pilot-maintenance.mjs";
import { assertPilotRecoveryDirectory } from "./pilot-recovery-command.mjs";

// This is private comparison evidence, never permission to release a Recovery lease.
export async function writePilotRecoveryBaseline({
  runtimeDirectory,
  folder,
  sourceDatabase,
  targetDatabase,
  container,
  port,
  postgresTables,
  simulatorTables,
  installationManifest,
  features,
}) {
  assertPilotRecoveryMaintenance(runtimeDirectory);
  const directory = await assertPilotRecoveryDirectory(runtimeDirectory, folder);
  const lease = await open(
    path.join(path.resolve(runtimeDirectory), "maintenance.lock"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let leaseSha256;
  try {
    const stat = await lease.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 1024
    )
      throw Error("RECOVERY_BASELINE_LEASE_INVALID");
    leaseSha256 = createHash("sha256")
      .update(await lease.readFile())
      .digest("hex");
  } finally {
    await lease.close();
  }
  const inventories = (tables) =>
    Object.fromEntries(
      Object.entries(tables).map(([name, entry]) => [
        name,
        { count: entry.count, digest: entry.digest },
      ]),
    );
  const value = {
    schemaVersion: 1,
    environment: "InternalTest",
    state: "QuiescedBeforeDump",
    recordedAt: new Date().toISOString(),
    runtimeDirectory,
    sourceDatabase,
    targetDatabase,
    container,
    port,
    leaseSha256,
    postgresTables: inventories(postgresTables),
    simulatorTables: inventories(simulatorTables),
    installationManifestSha256: createHash("sha256")
      .update(JSON.stringify(installationManifest))
      .digest("hex"),
    requiredFeatures: {
      diningExceptionProjection: true,
      reconciliationProjection: features.reconciliationProjection === true,
      dailySettlement: features.dailySettlement === true,
      batchCancellation: features.batchCancellation === true,
      compensation: features.compensation === true,
    },
    applicationsConnectedToTarget: false,
  };
  const file = await open(path.join(directory, "source-baseline.json"), "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
