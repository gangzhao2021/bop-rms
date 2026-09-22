import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { expect, it, vi } from "vitest";
import { assertPilotMaintenanceAccess } from "./pilot-maintenance.mjs";

const state = vi.hoisted(() => ({ failure: null, sourceReads: 0, runtime: null, commands: [] }));
const start = vi.hoisted(() => vi.fn(async () => ({ state: "started" })));
vi.mock("node:module", async (original) => ({
  ...(await original()),
  createRequire: () => () => ({
    Client: class {
      constructor(config) {
        this.source = config.database === "source";
      }
      async connect() {
        return undefined;
      }
      async end() {
        if (state.failure === "cleanup" && this.source) throw Error("PRIVATE_DETAIL");
      }
      async query(sql) {
        if (sql.startsWith("SELECT current_database")) return { rows: [{ db: "source" }] };
        if (sql.startsWith("SELECT 1 FROM pg_database")) return { rowCount: 0 };
        if (sql.includes("pg_export_snapshot")) return { rows: [{ snapshot: "synthetic" }] };
        if (sql.includes("FROM pg_class"))
          return { rows: [{ schema: "synthetic", name: "example" }] };
        if (sql.startsWith("SELECT count")) {
          if (this.source) state.sourceReads++;
          return {
            rows: [
              {
                count: "1",
                digest:
                  (state.failure === "target" && !this.source) ||
                  (state.failure === "source" && this.source && state.sourceReads > 1)
                    ? "changed"
                    : "same",
              },
            ],
          };
        }
        return { rows: [] };
      }
    },
  }),
}));
vi.mock("node:child_process", () => ({
  spawnSync: () => ({ status: 0, stdout: "127.0.0.1:55435" }),
}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    prepare() {
      return {
        all: () => [],
        get: () => ({ integrity_check: "ok" }),
        setReadBigInts() {
          return undefined;
        },
      };
    }
    close() {
      return undefined;
    }
  },
  backup: async () => undefined,
}));
vi.mock("../../packages/database/src/config.ts", () => ({
  loadMigrationConnectionConfig: async () => ({
    database: "source",
    port: 55435,
    user: "synthetic",
  }),
}));
vi.mock("./pilot-recovery-plan.mjs", () => ({
  parsePilotRecoveryArguments: () => ({
    runtimeDirectory: state.runtime,
    target: "target",
    container: "synthetic",
    label: "recovery-test",
  }),
  assertPilotRecoveryConnection: () => undefined,
}));
vi.mock("./pilot-installation.mjs", () => ({
  loadPilotInstallation: async () => ({
    database: "source",
    loadBusinessWorker: async () => ({ workloads: {} }),
  }),
}));
vi.mock("./pilot-installation-backup.mjs", () => ({
  backupPilotInstallation: async () => {
    if (state.failure === "baseline")
      await fs.writeFile(state.runtime + "/recovery-test/source-baseline.json", "existing", {
        mode: 0o600,
      });
    return { files: [], privateFixture: "NEVER_COPY_INSTALLATION_CONTENT" };
  },
  verifyPilotInstallationBackup: async () => {
    if (state.failure === "installation") throw Error("INSTALLATION_CHANGED");
  },
}));
vi.mock("./pilot-stop.mjs", () => ({
  stopPilotRuntime: async () => ({ state: state.failure === "stop" ? "failed" : "stopped" }),
}));
vi.mock("./pilot-start.mjs", () => ({ startPilotRuntime: start }));
vi.mock("./pilot-service.mjs", () => ({
  runPilotService: async () => undefined,
  confirmPilotServiceStopped: async () => true,
}));
vi.mock("./pilot-recovery-command.mjs", async (original) => ({
  ...(await original()),
  runPilotRecoveryCommand: async ({ runtimeDirectory, phase }) => {
    const baseline = JSON.parse(
      await fs.readFile(runtimeDirectory + "/recovery-test/source-baseline.json", "utf8"),
    );
    const leaseHash = createHash("sha256")
      .update(await fs.readFile(runtimeDirectory + "/maintenance.lock"))
      .digest("hex");
    state.commands.push({ phase, baseline, leaseHash });
    if (state.failure === "docker") {
      const { retainPilotRecoveryMaintenance } = await import("./pilot-maintenance.mjs");
      retainPilotRecoveryMaintenance(runtimeDirectory);
      throw Error("RECOVERY_COMMAND_REVIEW_REQUIRED");
    }
  },
}));
import { runPilotRecovery } from "./pilot-recovery.mjs";

it.each([null, "source", "target", "installation", "stop", "cleanup", "docker", "baseline"])(
  "restarts only after successful recovery and cleanup: %s",
  async (failure) => {
    state.runtime = ".local/recovery-safety-" + randomUUID();
    state.failure = failure;
    state.sourceReads = 0;
    state.commands = [];
    start.mockClear();
    const originalExitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await fs.mkdir(state.runtime, { mode: 0o700 });
    try {
      await runPilotRecovery([]);
      const expectedCommands = ["stop", "baseline"].includes(failure)
        ? 0
        : failure === "docker"
          ? 1
          : 2;
      expect(state.commands).toHaveLength(expectedCommands);
      for (const command of state.commands) {
        expect(command.baseline.leaseSha256).toBe(command.leaseHash);
        expect(command.baseline.state).toBe("QuiescedBeforeDump");
        expect(command.baseline.sourceDatabase).toBe("source");
        expect(command.baseline.targetDatabase).toBe("target");
        expect(command.baseline.postgresTables["synthetic.example"].digest).toBe("same");
        expect(command.baseline.simulatorTables).toEqual({});
        expect(command.baseline.installationManifestSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(command.baseline)).not.toContain("NEVER_COPY_INSTALLATION_CONTENT");
      }
      if (expectedCommands)
        expect(
          (await fs.stat(state.runtime + "/recovery-test/source-baseline.json")).mode & 0o777,
        ).toBe(0o600);
      if (failure === "baseline")
        expect(
          await fs.readFile(state.runtime + "/recovery-test/source-baseline.json", "utf8"),
        ).toBe("existing");
      if (failure) {
        expect(process.exitCode).toBe(1);
        expect(start).not.toHaveBeenCalled();
        await expect(assertPilotMaintenanceAccess(state.runtime, "start")).rejects.toThrow(
          "PILOT_MAINTENANCE_ACTIVE",
        );
        const lease = JSON.parse(await fs.readFile(state.runtime + "/maintenance.lock", "utf8"));
        expect(lease.operation).toBe("Recovery");
        expect(JSON.stringify(error.mock.calls)).not.toContain("PRIVATE_DETAIL");
      } else {
        expect(start).toHaveBeenCalledOnce();
        await assertPilotMaintenanceAccess(state.runtime, "start");
        const evidence = JSON.parse(
          await fs.readFile(state.runtime + "/recovery-test/evidence.json", "utf8"),
        );
        expect(evidence.sourcePreserved).toBe(true);
      }
    } finally {
      process.exitCode = originalExitCode;
      log.mockRestore();
      error.mockRestore();
      await fs.rm(state.runtime, { recursive: true, force: true });
    }
  },
);
