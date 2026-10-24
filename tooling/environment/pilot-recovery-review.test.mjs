import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { withPilotMaintenance, retainPilotRecoveryMaintenance } from "./pilot-maintenance.mjs";
import { writePilotRecoveryBaseline } from "./pilot-recovery-baseline.mjs";
const state = vi.hoisted(() => ({ mode: null, queries: [], stopped: 0, reviews: 0 }));
vi.mock("node:module", async (original) => ({
  ...(await original()),
  createRequire: () => () => ({
    Client: class {
      async connect() {
        return undefined;
      }
      async end() {
        if (state.mode === "close") throw Error("PRIVATE_ERROR");
      }
      async query(sql) {
        state.queries.push(sql);
        if (sql.startsWith("SELECT current_database")) return { rows: [{ db: "source" }] };
        if (sql.includes("pg_stat_activity"))
          return { rows: [{ count: state.mode === "connection" ? "1" : "0" }] };
        if (sql.includes("FROM pg_class"))
          return { rows: state.mode === "source" ? [{ schema: "unexpected", name: "table" }] : [] };
        if (sql.startsWith("SELECT count")) return { rows: [{ count: "1", digest: "changed" }] };
        return { rows: [] };
      }
    },
  }),
}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    prepare() {
      return {
        get: () => ({ integrity_check: state.mode === "sqlite" ? "corrupt" : "ok" }),
        all: () => [],
      };
    }
    close() {
      return undefined;
    }
  },
}));
vi.mock("node:child_process", () => ({
  spawnSync: (_command, args) => ({
    status: 0,
    stdout:
      args[0] === "port"
        ? "127.0.0.1:55435"
        : state.mode === "container"
          ? "PID COMMAND\n1 docker-init\n2 postgres\n3 pg_restore"
          : "PID COMMAND\n1 docker-init\n2 postgres",
  }),
}));
vi.mock("../../packages/database/src/config.ts", () => ({
  loadMigrationConnectionConfig: async () => ({
    environment: "local",
    database: "source",
    host: "127.0.0.1",
    port: 55435,
  }),
}));
vi.mock("./pilot-installation.mjs", () => ({
  loadPilotInstallation: async () => ({
    database: "source",
    connection: { host: "127.0.0.1", port: 55435 },
  }),
}));
vi.mock("./pilot-installation-backup.mjs", () => ({
  verifyPilotInstallationBackup: async () => {
    if (state.mode === "installation") throw Error("PRIVATE_ERROR");
  },
}));
vi.mock("./pilot-maintenance-status.mjs", () => ({
  readPilotMaintenanceStatus: async () => {
    state.reviews++;
    return {
      state:
        state.mode === "owner" || (state.mode === "changed-owner" && state.reviews > 1)
          ? "OwnerActive"
          : "OwnerExitedReviewRequired",
      operation: "Recovery",
    };
  },
}));
vi.mock("./pilot-service.mjs", async (original) => ({
  ...(await original()),
  confirmPilotServiceStopped: async () => {
    state.stopped++;
    return state.mode !== "service";
  },
}));
import { reviewPilotRecovery } from "./pilot-recovery-review.mjs";

it.each([
  null,
  "source",
  "sqlite",
  "connection",
  "installation",
  "container",
  "owner",
  "changed-owner",
  "service",
  "close",
  "manifest",
  "lease",
  "supervisor",
  "baseline-link",
])("read-only source comparison retains exclusion: %s", async (mode) => {
  const runtimeDirectory = ".local/recovery-review-" + randomUUID();
  const folder = path.resolve(runtimeDirectory, "recovery-test");
  state.mode = mode;
  state.queries = [];
  state.stopped = 0;
  state.reviews = 0;
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  await fs.mkdir(runtimeDirectory, { mode: 0o700 });
  await fs.mkdir(folder, { mode: 0o700 });
  await fs.mkdir(folder + "/installation", { mode: 0o700 });
  const installationManifest = { files: [] };
  await fs.writeFile(folder + "/installation/manifest.json", JSON.stringify(installationManifest), {
    mode: 0o600,
  });
  try {
    await withPilotMaintenance(
      runtimeDirectory,
      async () => {
        await writePilotRecoveryBaseline({
          runtimeDirectory,
          folder,
          sourceDatabase: "source",
          targetDatabase: "bop_rms_test_restore_review",
          container: "synthetic",
          port: 55435,
          postgresTables: {},
          simulatorTables: {},
          installationManifest,
          features: {},
        });
        retainPilotRecoveryMaintenance(runtimeDirectory);
      },
      "Recovery",
    );
    if (mode === "manifest")
      await fs.writeFile(
        folder + "/installation/manifest.json",
        JSON.stringify({ files: ["changed"] }),
      );
    if (mode === "lease") await fs.appendFile(runtimeDirectory + "/maintenance.lock", " ");
    if (mode === "supervisor")
      await fs.writeFile(runtimeDirectory + "/supervisor.lock", "existing");
    if (mode === "baseline-link") {
      await fs.rename(folder + "/source-baseline.json", folder + "/baseline-original.json");
      await fs.symlink(folder + "/baseline-original.json", folder + "/source-baseline.json");
    }
    const before = await fs.readFile(runtimeDirectory + "/maintenance.lock");
    const result = reviewPilotRecovery([
      runtimeDirectory,
      "bop_rms_test_restore_review",
      "synthetic",
      "recovery-test",
    ]);
    if (mode) await expect(result).rejects.toThrow();
    else {
      expect(await result).toEqual({
        state: "SourceComparisonMatchedReviewRequired",
        sourceUnchanged: true,
        servicesConfirmedStopped: 7,
        maintenanceRetained: true,
        servicesStarted: false,
        targetRestorationVerified: false,
      });
      expect(state.stopped).toBe(14);
    }
    expect(await fs.readFile(runtimeDirectory + "/maintenance.lock")).toEqual(before);
    expect(
      state.queries.every((sql) =>
        /^(SELECT|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|COMMIT)/.test(sql),
      ),
    ).toBe(true);
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});
