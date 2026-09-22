import { inventory, sqliteInventory } from "./pilot-recovery-inventory.mjs";
import { writePilotRecoveryBaseline } from "./pilot-recovery-baseline.mjs";
import { runPilotRecoveryCommand } from "./pilot-recovery-command.mjs";
import { withPilotMaintenance, retainPilotRecoveryMaintenance } from "./pilot-maintenance.mjs";
import {
  backupPilotInstallation,
  verifyPilotInstallationBackup,
} from "./pilot-installation-backup.mjs";
import { createRequire } from "node:module";
import { mkdir, open, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { DatabaseSync, backup } from "node:sqlite";
import { loadMigrationConnectionConfig } from "../../packages/database/src/config.ts";
import { stopPilotRuntime } from "./pilot-stop.mjs";
import { startPilotRuntime } from "./pilot-start.mjs";
import { runPilotService, confirmPilotServiceStopped } from "./pilot-service.mjs";
import process from "node:process";
import console from "node:console";
import path from "node:path";
import { fileURLToPath, URL, pathToFileURL } from "node:url";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import {
  parsePilotRecoveryArguments,
  assertPilotRecoveryConnection,
} from "./pilot-recovery-plan.mjs";
export async function runPilotRecovery(args) {
  const plan = parsePilotRecoveryArguments(args);
  return withPilotMaintenance(
    plan.runtimeDirectory,
    () => runPilotRecoveryInMaintenance(args),
    "Recovery",
  );
}
async function runPilotRecoveryInMaintenance(args) {
  const plan = parsePilotRecoveryArguments(args);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = path.join(root, plan.runtimeDirectory),
    folder = path.join(dir, plan.label);
  if (process.cwd() !== root.replace(/\/$/, "")) throw Error("RECOVERY_ROOT_INVALID");
  const installation = await loadPilotInstallation(dir);
  const workloadConfig = await installation.loadBusinessWorker();
  let requireReconciliationProjection = false;
  let requireDailySettlement = false;
  const config = await loadMigrationConnectionConfig(
    root,
    plan.runtimeDirectory + "/environment.env",
    {},
  );
  assertPilotRecoveryConnection(plan, installation, config, process.env.NODE_ENV);
  const source = installation.database,
    target = plan.target,
    container = plan.container;
  const { Client } = createRequire(path.join(root, "packages/database/package.json"))("pg");
  const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
  const sourceClient = new Client({ ...config, query_timeout: 120000 }),
    restoredClient = new Client({ ...config, database: target, query_timeout: 120000 });
  let recoveryStarted = false,
    resume = false,
    connectedTarget = false,
    sqlite,
    restoredSqlite,
    errors;
  async function command(phase, args, stdio) {
    try {
      await runPilotRecoveryCommand({
        runtimeDirectory: plan.runtimeDirectory,
        folder,
        phase,
        args,
        stdio,
      });
    } catch (error) {
      resume = false;
      throw error;
    }
  }
  try {
    await sourceClient.connect();
    if ((await sourceClient.query("SELECT current_database() AS db")).rows[0].db !== source)
      throw Error("SOURCE_MISMATCH");
    if (
      (await sourceClient.query("SELECT 1 FROM pg_database WHERE datname=$1", [target]))
        .rowCount !== 0
    )
      throw Error("TARGET_ALREADY_EXISTS");
    for (const name of [
      "api",
      "customer",
      "business-worker",
      "kitchen-queue-worker",
      "dining-exception-worker",
    ])
      await runPilotService("status", name, plan.runtimeDirectory);
    const port = spawnSync("docker", ["port", container, "5432/tcp"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (port.error || port.status !== 0 || port.stdout.trim() !== "127.0.0.1:" + config.port)
      throw Error("RECOVERY_CONTAINER_BINDING_INVALID");
    try {
      await runPilotService("status", "reconciliation-worker", plan.runtimeDirectory);
      requireReconciliationProjection = true;
    } catch {
      if (
        !(await confirmPilotServiceStopped({
          root: root.replace(/\/$/, ""),
          service: "reconciliation-worker",
          pid: null,
          runtimeDirectory: plan.runtimeDirectory,
        }))
      )
        throw Error("RECOVERY_OPTIONAL_WORKER_UNRESOLVED");
    }
    try {
      await runPilotService("status", "daily-settlement-worker", plan.runtimeDirectory);
      requireDailySettlement = true;
    } catch {
      if (
        !(await confirmPilotServiceStopped({
          root: root.replace(/\/$/, ""),
          service: "daily-settlement-worker",
          pid: null,
          runtimeDirectory: plan.runtimeDirectory,
        }))
      )
        throw Error("RECOVERY_OPTIONAL_WORKER_UNRESOLVED");
    }
    await mkdir(folder, { mode: 0o700 });
    errors = await open(folder + "/private-errors.log", "wx", 0o600);
    recoveryStarted = true;
    if ((await stopPilotRuntime({ runtimeDirectory: plan.runtimeDirectory })).state !== "stopped")
      throw Error("STOP_INCOMPLETE");
    const installationBackup = await backupPilotInstallation({
      root: root.replace(/\/$/, ""),
      directory: dir,
      destination: folder + "/installation",
      requireDailySettlement,
    });
    await sourceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = (await sourceClient.query("SELECT pg_export_snapshot() AS snapshot")).rows[0]
      .snapshot;
    const before = await inventory(sourceClient);
    sqlite = new DatabaseSync(dir + "/simulated-provider.sqlite", { readOnly: true });
    const sqliteBefore = sqliteInventory(sqlite);
    const file = await open(folder + "/simulated-provider.sqlite", "wx", 0o600);
    await file.close();
    await backup(sqlite, folder + "/simulated-provider.sqlite");
    sqlite.close();
    sqlite = undefined;
    await writePilotRecoveryBaseline({
      runtimeDirectory: plan.runtimeDirectory,
      folder,
      sourceDatabase: source,
      targetDatabase: target,
      container,
      port: config.port,
      postgresTables: before,
      simulatorTables: sqliteBefore,
      installationManifest: installationBackup,
      features: {
        reconciliationProjection: requireReconciliationProjection,
        dailySettlement: requireDailySettlement,
        batchCancellation: workloadConfig.workloads.batchCancellation,
        compensation: workloadConfig.workloads.compensation,
      },
    });
    const dump = await open(folder + "/database.dump", "wx", 0o600);
    try {
      await command(
        "Dump",
        [
          "exec",
          container,
          "pg_dump",
          "-U",
          config.user,
          "-d",
          source,
          "--format=custom",
          "--snapshot=" + snapshot,
        ],
        ["ignore", dump.fd, errors.fd],
      );
    } finally {
      await dump.close();
    }
    await sourceClient.query("COMMIT");
    if ((await stopPilotRuntime({ runtimeDirectory: plan.runtimeDirectory })).state !== "stopped")
      throw Error("QUIESCENCE_LOST");
    await sourceClient.query("CREATE DATABASE " + quote(target) + " TEMPLATE template0");
    const dumpInput = await open(folder + "/database.dump", "r");
    try {
      await command(
        "Restore",
        [
          "exec",
          "-i",
          container,
          "pg_restore",
          "-U",
          config.user,
          "-d",
          target,
          "--single-transaction",
          "--exit-on-error",
        ],
        [dumpInput.fd, "ignore", errors.fd],
      );
    } finally {
      await dumpInput.close();
    }
    await restoredClient.connect();
    connectedTarget = true;
    const after = await inventory(restoredClient);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("POSTGRES_CONTENT_MISMATCH");
    const sourceAfter = await inventory(sourceClient);
    if (JSON.stringify(before) !== JSON.stringify(sourceAfter))
      throw Error("SOURCE_CHANGED_DURING_DRILL");
    restoredSqlite = new DatabaseSync(folder + "/simulated-provider.sqlite", { readOnly: true });
    const sqliteAfter = sqliteInventory(restoredSqlite);
    if (
      JSON.stringify(sqliteBefore) !== JSON.stringify(sqliteAfter) ||
      Object.values(restoredSqlite.prepare("PRAGMA integrity_check").get())[0] !== "ok"
    )
      throw Error("SIMULATOR_CONTENT_MISMATCH");
    restoredSqlite.close();
    restoredSqlite = undefined;
    await verifyPilotInstallationBackup({
      root: root.replace(/\/$/, ""),
      destination: folder + "/installation",
      manifest: installationBackup,
    });
    const evidence = {
      installationFiles: installationBackup.files.length,
      installationPreserved: true,
      schemaVersion: 1,
      environment: "InternalTest",
      sourceDatabase: source,
      targetDatabase: target,
      sourcePreserved: true,
      postgresTables: before,
      simulatorTables: sqliteBefore,
      completedAt: new Date().toISOString(),
      applicationsConnectedToTarget: false,
      credentialsExported: false,
    };
    await writeFile(folder + "/evidence.json", JSON.stringify(evidence, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        recoveryVerified: true,
        postgresTables: Object.keys(before).length,
        postgresRows: Object.values(before).reduce((n, v) => n + Number(v.count), 0),
        simulatorTables: Object.keys(sqliteBefore).length,
        simulatorRows: Object.values(sqliteBefore).reduce((n, v) => n + v.count, 0),
        sourcePreserved: true,
        targetIsolated: true,
        credentialsExported: false,
      }),
    );
    resume = true;
  } catch (e) {
    if (recoveryStarted) retainPilotRecoveryMaintenance(plan.runtimeDirectory);
    console.error(
      JSON.stringify({
        recoveryVerified: false,
        code: /^[A-Z_]{1,80}$/.test(String(e.message)) ? e.message : "RECOVERY_UNAVAILABLE",
      }),
    );
    process.exitCode = 1;
  } finally {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => sqlite?.close()),
      Promise.resolve().then(() => restoredSqlite?.close()),
      Promise.resolve().then(() => errors?.close()),
      Promise.resolve().then(() => (connectedTarget ? restoredClient.end() : undefined)),
      Promise.resolve().then(() => sourceClient.end()),
    ]);
    if (cleanup.some((result) => result.status === "rejected")) {
      resume = false;
      if (recoveryStarted) retainPilotRecoveryMaintenance(plan.runtimeDirectory);
      console.error("RECOVERY_RESOURCE_CLOSE_UNAVAILABLE");
      process.exitCode = 1;
    }
    if (resume) {
      const result = await startPilotRuntime({
        runtimeDirectory: plan.runtimeDirectory,
        requireDiningExceptionProjection: true,
        requireReconciliationProjection,
        requireDailySettlement,
        requireBatchCancellation: workloadConfig.workloads.batchCancellation,
        requireCompensation: workloadConfig.workloads.compensation,
      });
      console.log(
        JSON.stringify({
          sourceServicesRestored: result.state === "started",
          stage: result.stage ?? null,
        }),
      );
      if (result.state !== "started") process.exitCode = 1;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runPilotRecovery(process.argv.slice(2));
  } catch {
    console.error("PILOT_RECOVERY_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}
