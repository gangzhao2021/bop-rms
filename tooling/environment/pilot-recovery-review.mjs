import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { pathToFileURL } from "node:url";
import { loadMigrationConnectionConfig } from "../../packages/database/src/config.ts";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { verifyPilotInstallationBackup } from "./pilot-installation-backup.mjs";
import {
  parsePilotRecoveryArguments,
  assertPilotRecoveryConnection,
} from "./pilot-recovery-plan.mjs";
import { assertPilotRecoveryDirectory } from "./pilot-recovery-command.mjs";
import { readPilotMaintenanceStatus } from "./pilot-maintenance-status.mjs";
import { confirmPilotServiceStopped } from "./pilot-service.mjs";
import { inventory, sqliteInventory } from "./pilot-recovery-inventory.mjs";
const fail = () => {
  throw Error("PILOT_RECOVERY_REVIEW_REQUIRED");
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const services = [
  "customer",
  "api",
  "business-worker",
  "kitchen-queue-worker",
  "reconciliation-worker",
  "daily-settlement-worker",
  "dining-exception-worker",
];
async function privateRead(file, limit = 1048576) {
  if ((await fs.realpath(file)) !== file) fail();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.size > limit)
      fail();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function inspectPilotRecoveryScope(args) {
  const plan = parsePilotRecoveryArguments(args),
    root = await fs.realpath(process.cwd());
  const directory = path.join(root, plan.runtimeDirectory);
  const folder = await assertPilotRecoveryDirectory(
    plan.runtimeDirectory,
    path.join(directory, plan.label),
  );
  const baselineBytes = await privateRead(path.join(folder, "source-baseline.json"));
  const baseline = JSON.parse(baselineBytes);
  const installation = await loadPilotInstallation(directory);
  const config = await loadMigrationConnectionConfig(
    root,
    plan.runtimeDirectory + "/environment.env",
    {},
  );
  assertPilotRecoveryConnection(plan, installation, config, process.env.NODE_ENV);
  if (
    baseline.schemaVersion !== 1 ||
    baseline.environment !== "InternalTest" ||
    baseline.state !== "QuiescedBeforeDump" ||
    baseline.runtimeDirectory !== plan.runtimeDirectory ||
    baseline.sourceDatabase !== installation.database ||
    baseline.targetDatabase !== plan.target ||
    baseline.container !== plan.container ||
    baseline.port !== config.port ||
    baseline.applicationsConnectedToTarget !== false
  )
    fail();
  return { plan, root, directory, folder, baselineBytes, baseline, installation, config };
}
export async function reviewPilotRecovery(args) {
  const { plan, root, directory, folder, baselineBytes, baseline, config } =
    await inspectPilotRecoveryScope(args);
  const leaseFile = path.join(directory, "maintenance.lock"),
    leaseIdentity = await fs.lstat(leaseFile);
  async function exclusion() {
    const status = await readPilotMaintenanceStatus(plan.runtimeDirectory);
    if (status.state !== "OwnerExitedReviewRequired" || status.operation !== "Recovery") fail();
    const current = await fs.lstat(leaseFile);
    if (
      current.ino !== leaseIdentity.ino ||
      current.dev !== leaseIdentity.dev ||
      digest(await privateRead(leaseFile, 1024)) !== baseline.leaseSha256 ||
      !(await privateRead(path.join(folder, "source-baseline.json"))).equals(baselineBytes)
    )
      fail();
    for (const name of [
      "supervisor.lock",
      "supervisor-control.lock",
      "maintenance-clear-stop.lock",
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
    for (const service of services) {
      let pid = null;
      try {
        const text = (await privateRead(path.join(directory, service + ".pid"), 32))
          .toString()
          .trim();
        if (!/^[1-9][0-9]*$/u.test(text) || !Number.isSafeInteger(Number(text))) fail();
        pid = Number(text);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (
        !(await confirmPilotServiceStopped({
          root,
          service,
          pid,
          runtimeDirectory: plan.runtimeDirectory,
        }))
      )
        fail();
    }
    const port = spawnSync("docker", ["port", plan.container, "5432/tcp"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (port.error || port.status !== 0 || port.stdout.trim() !== "127.0.0.1:" + config.port)
      fail();
    const top = spawnSync("docker", ["top", plan.container, "-eo", "pid,comm"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (top.error || top.status !== 0) fail();
    const commands = top.stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim());
    if (
      !/^PID\s+COMMAND$/u.test(commands.shift() ?? "") ||
      commands.length === 0 ||
      commands.some((command) => !/^[1-9][0-9]*\s+(postgres|docker-init)$/u.test(command))
    )
      fail();
  }
  await exclusion();
  const { Client } = createRequire(path.join(root, "packages/database/package.json"))("pg");
  const client = new Client({ ...config, query_timeout: 120000 });
  let sqlite;
  try {
    await client.connect();
    if (
      (await client.query("SELECT current_database() AS db")).rows[0].db !== baseline.sourceDatabase
    )
      fail();
    const inactive = async () => {
      const result = await client.query(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND pid<>pg_backend_pid()",
        [[baseline.sourceDatabase, baseline.targetDatabase]],
      );
      if (result.rows[0]?.count !== "0") fail();
    };
    await inactive();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const actual = await inventory(client);
    await client.query("COMMIT");
    if (JSON.stringify(actual) !== JSON.stringify(baseline.postgresTables)) fail();
    sqlite = new DatabaseSync(path.join(directory, "simulated-provider.sqlite"), {
      readOnly: true,
    });
    if (
      Object.values(sqlite.prepare("PRAGMA integrity_check").get())[0] !== "ok" ||
      JSON.stringify(sqliteInventory(sqlite)) !== JSON.stringify(baseline.simulatorTables)
    )
      fail();
    const manifest = JSON.parse(await privateRead(path.join(folder, "installation/manifest.json")));
    if (digest(JSON.stringify(manifest)) !== baseline.installationManifestSha256) fail();
    await verifyPilotInstallationBackup({
      root,
      destination: path.join(folder, "installation"),
      manifest,
    });
    await inactive();
    await exclusion();
    return {
      state: "SourceComparisonMatchedReviewRequired",
      sourceUnchanged: true,
      servicesConfirmedStopped: services.length,
      maintenanceRetained: true,
      servicesStarted: false,
      targetRestorationVerified: false,
    };
  } finally {
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => sqlite?.close()),
      Promise.resolve().then(() => client.end()),
    ]);
    if (closed.some((result) => result.status === "rejected")) fail();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await reviewPilotRecovery(process.argv.slice(2))));
  } catch {
    console.error("PILOT_RECOVERY_REVIEW_REQUIRED");
    process.exitCode = 1;
  }
}

export { privateRead as readPilotRecoveryPrivateFile };
