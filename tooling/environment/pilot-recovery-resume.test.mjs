import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  withPilotMaintenance,
  retainPilotRecoveryMaintenance,
  assertPilotMaintenanceAccess,
} from "./pilot-maintenance.mjs";
import { writePilotRecoveryBaseline } from "./pilot-recovery-baseline.mjs";
const state = vi.hoisted(() => ({
  mode: null,
  runtime: null,
  folder: null,
  starts: 0,
  actions: [],
}));
vi.mock("./pilot-maintenance-status.mjs", () => ({
  readPilotMaintenanceStatus: async () => ({
    state: "OwnerExitedReviewRequired",
    operation: "Recovery",
  }),
}));
vi.mock("./pilot-recovery-review.mjs", async (original) => ({
  ...(await original()),
  inspectPilotRecoveryScope: async () => {
    const folder = path.resolve(state.runtime, "recovery-test");
    const baselineBytes = await fs.readFile(path.join(folder, "source-baseline.json"));
    return { folder, baselineBytes, baseline: JSON.parse(baselineBytes) };
  },
  reviewPilotRecovery: async () => {
    state.actions.push({ action: "review" });
    const controlOwner = JSON.parse(
      await fs.readFile(state.runtime + "/recovery-resume.lock/owner.json", "utf8"),
    );
    expect(controlOwner).toMatchObject({
      schemaVersion: 1,
      pid: process.pid,
      label: "recovery-test",
    });
    if (state.mode === "review") throw Error("PRIVATE_REVIEW_ERROR");
    if (state.mode === "lease") await fs.appendFile(state.runtime + "/maintenance.lock", " ");
    return { state: "SourceComparisonMatchedReviewRequired" };
  },
}));
vi.mock("./pilot-service.mjs", async (original) => ({
  ...(await original()),
  runPilotService: async (action, name, runtime) => {
    await assertPilotMaintenanceAccess(runtime, action);
    state.actions.push({ action, name });
    if (state.mode === "stop" && action === "stop" && name === "api") throw Error("STOP_FAILED");
    return { service: name, state: action === "stop" ? "stopped" : "started" };
  },
}));
vi.mock("./pilot-start.mjs", () => ({
  startPilotRuntime: async (options) => {
    state.starts++;
    const controlOwner = JSON.parse(
      await fs.readFile(state.runtime + "/recovery-resume.lock/owner.json", "utf8"),
    );
    if (controlOwner.attempt)
      state.folder = path.resolve(state.runtime, "recovery-test", controlOwner.attempt);
    expect(options).toMatchObject({
      requireDiningExceptionProjection: true,
      requireDailySettlement: true,
      requireReconciliationProjection: true,
      requireBatchCancellation: true,
      requireCompensation: true,
    });
    expect(
      JSON.parse(await fs.readFile(state.runtime + "/maintenance.lock", "utf8")).operation,
    ).toBe("Recovery");
    expect(
      JSON.parse(await fs.readFile(state.folder + "/source-resume-started.json", "utf8")).state,
    ).toBe("Started");
    await expect(assertPilotMaintenanceAccess(state.runtime, "restart")).rejects.toThrow();
    await expect(withPilotMaintenance(state.runtime, async () => "forbidden")).rejects.toThrow();
    await options.service("start", "api", state.runtime);
    if (state.mode === "completion")
      await fs.writeFile(state.folder + "/source-resume-completed.json", "collision", {
        mode: 0o600,
      });
    if (state.mode === "throw") throw Error("PRIVATE_START_ERROR");
    return { state: state.mode === "startup" ? "incomplete" : "started" };
  },
}));
import { writePilotResumeOwner } from "./pilot-recovery-resume-owner.mjs";
import { resumePilotRecoverySource } from "./pilot-recovery-resume.mjs";
it.each([null, "review", "lease", "concurrent", "duplicate", "startup", "throw", "completion"])(
  "controlled source resume: %s",
  async (mode) => {
    state.mode = mode;
    state.runtime = ".local/recovery-resume-" + randomUUID();
    state.folder = path.resolve(state.runtime, "recovery-test");
    state.starts = 0;
    state.actions = [];
    const priorEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    await fs.mkdir(state.runtime, { mode: 0o700 });
    await fs.mkdir(state.folder, { mode: 0o700 });
    try {
      await withPilotMaintenance(
        state.runtime,
        async () => {
          await writePilotRecoveryBaseline({
            runtimeDirectory: state.runtime,
            folder: state.folder,
            sourceDatabase: "source",
            targetDatabase: "bop_rms_test_restore_resume",
            container: "synthetic",
            port: 55435,
            postgresTables: {},
            simulatorTables: {},
            installationManifest: {},
            features: {
              dailySettlement: true,
              reconciliationProjection: true,
              batchCancellation: true,
              compensation: true,
            },
          });
          retainPilotRecoveryMaintenance(state.runtime);
        },
        "Recovery",
      );
      const lease = await fs.readFile(state.runtime + "/maintenance.lock");
      if (mode === "concurrent")
        await fs.mkdir(state.runtime + "/recovery-resume.lock", { mode: 0o700 });
      if (mode === "duplicate")
        await fs.writeFile(state.folder + "/source-resume-started.json", "prior", { mode: 0o600 });
      const result = resumePilotRecoverySource([
        state.runtime,
        "bop_rms_test_restore_resume",
        "synthetic",
        "recovery-test",
      ]);
      if (mode) {
        await expect(result).rejects.toThrow();
        await expect(assertPilotMaintenanceAccess(state.runtime, "start")).rejects.toThrow();
        const remaining = await fs.readFile(state.runtime + "/maintenance.lock");
        expect(remaining).toEqual(
          mode === "lease" ? Buffer.concat([lease, Buffer.from(" ")]) : lease,
        );
        if (["startup", "throw", "completion"].includes(mode)) {
          expect(state.starts).toBe(1);
          expect(state.actions.filter((entry) => entry.action === "stop")).toHaveLength(7);
        } else expect(state.starts).toBe(0);
      } else {
        expect(await result).toEqual({
          state: "SourceResumed",
          maintenanceReleased: true,
          targetRestorationVerified: false,
          targetPromoted: false,
          supervisorStarted: false,
        });
        await assertPilotMaintenanceAccess(state.runtime, "start");
        expect(state.starts).toBe(1);
        const completed = JSON.parse(
          await fs.readFile(state.folder + "/source-resume-completed.json", "utf8"),
        );
        expect(completed.originalLease).toEqual(JSON.parse(lease.toString()));
        expect((await fs.stat(state.folder + "/source-resume-completed.json")).mode & 0o777).toBe(
          0o600,
        );
        expect(state.actions.filter((entry) => entry.action === "stop")).toHaveLength(0);
      }
      if (mode === "concurrent")
        expect((await fs.stat(state.runtime + "/recovery-resume.lock")).isDirectory()).toBe(true);
      else
        await expect(fs.stat(state.runtime + "/recovery-resume.lock")).rejects.toMatchObject({
          code: "ENOENT",
        });
    } finally {
      if (priorEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorEnvironment;
      await fs.rm(state.runtime, { recursive: true, force: true });
    }
  },
);

// Scope/database and service effects are injected; private owner/lease/attempt handling is real.
it.each(["success", "review", "stop", "startup"])(
  "interrupted resume preserves evidence: %s",
  async (mode) => {
    state.mode = mode;
    state.runtime = ".local/recovery-resume-" + randomUUID();
    const originalFolder = path.resolve(state.runtime, "recovery-test");
    state.folder = originalFolder;
    state.starts = 0;
    state.actions = [];
    const priorEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    await fs.mkdir(state.runtime, { mode: 0o700 });
    await fs.mkdir(originalFolder, { mode: 0o700 });
    try {
      await withPilotMaintenance(
        state.runtime,
        async () => {
          await writePilotRecoveryBaseline({
            runtimeDirectory: state.runtime,
            folder: originalFolder,
            sourceDatabase: "source",
            targetDatabase: "bop_rms_test_restore_resume",
            container: "synthetic",
            port: 55435,
            postgresTables: {},
            simulatorTables: {},
            installationManifest: {},
            features: {
              dailySettlement: true,
              reconciliationProjection: true,
              batchCancellation: true,
              compensation: true,
            },
          });
          retainPilotRecoveryMaintenance(state.runtime);
        },
        "Recovery",
      );
      const lease = await fs.readFile(state.runtime + "/maintenance.lock");
      const baseline = JSON.parse(
        await fs.readFile(originalFolder + "/source-baseline.json", "utf8"),
      );
      const control = path.resolve(state.runtime, "recovery-resume.lock");
      await fs.mkdir(control, { mode: 0o700 });
      const owner = await writePilotResumeOwner(control, "recovery-test", baseline.leaseSha256);
      const departed = JSON.parse(owner.bytes);
      departed.bootId = "00000000-0000-0000-0000-000000000000";
      const oldOwner = JSON.stringify(departed);
      await fs.writeFile(owner.file, oldOwner, { mode: 0o600 });
      const oldStarted = JSON.stringify({
        schemaVersion: 1,
        state: "Started",
        recordedAt: "2026-09-22T00:00:00.000Z",
        leaseSha256: baseline.leaseSha256,
        originalLease: JSON.parse(lease),
        targetRestorationVerified: false,
      });
      await fs.writeFile(originalFolder + "/source-resume-started.json", oldStarted, {
        mode: 0o600,
      });
      // Startup reads the new attempt selected by its durable owner record.
      const result = resumePilotRecoverySource(
        [state.runtime, "bop_rms_test_restore_resume", "synthetic", "recovery-test"],
        { takeover: true },
      );
      if (mode === "success")
        expect(await result).toMatchObject({ state: "SourceResumed", targetPromoted: false });
      else await expect(result).rejects.toThrow();
      const attempts = (await fs.readdir(originalFolder)).filter((name) =>
        name.startsWith("resume-attempt-"),
      );
      expect(attempts).toHaveLength(1);
      const attempt = path.join(originalFolder, attempts[0]);
      expect(await fs.readFile(attempt + "/prior-owner.json", "utf8")).toBe(oldOwner);
      expect(await fs.readFile(originalFolder + "/source-resume-started.json", "utf8")).toBe(
        oldStarted,
      );
      expect(state.actions.slice(0, 7).map((item) => item.action)).toEqual(Array(7).fill("stop"));
      expect(state.starts).toBe(["success", "startup"].includes(mode) ? 1 : 0);
      if (mode === "stop")
        expect(state.actions.some((item) => item.action === "review")).toBe(false);
      else expect(state.actions[7].action).toBe("review");
      if (mode === "success") {
        await expect(fs.stat(control)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(state.runtime + "/maintenance.lock")).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          JSON.parse(await fs.readFile(attempt + "/source-resume-completed.json", "utf8")).state,
        ).toBe("Completed");
      } else {
        expect(await fs.readFile(state.runtime + "/maintenance.lock")).toEqual(lease);
        expect(JSON.parse(await fs.readFile(control + "/owner.json", "utf8")).attempt).toBe(
          attempts[0],
        );
      }
      await expect(fs.stat(state.runtime + "/recovery-resume-takeover.lock")).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    } finally {
      if (priorEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorEnvironment;
      await fs.rm(state.runtime, { recursive: true, force: true });
    }
  },
);
