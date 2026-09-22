import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { withPilotMaintenance, assertPilotMaintenanceAccess } from "./pilot-maintenance.mjs";
import { runPilotRecoveryCommand } from "./pilot-recovery-command.mjs";
async function fixture(work) {
  const runtimeDirectory = ".local/recovery-command-" + randomUUID(),
    folder = runtimeDirectory + "/recovery-test";
  await fs.mkdir(runtimeDirectory, { mode: 0o700 });
  await fs.mkdir(folder, { mode: 0o700 });
  try {
    await work({ runtimeDirectory, folder, phase: "Dump", args: ["synthetic"], stdio: "ignore" });
  } finally {
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
}
it("records durable private phase markers before and after successful execution", async () => {
  await fixture(async (options) => {
    const execute = vi.fn(() => ({ status: 0 }));
    await withPilotMaintenance(
      options.runtimeDirectory,
      async () => {
        await runPilotRecoveryCommand({ ...options, execute });
        await runPilotRecoveryCommand({ ...options, phase: "Restore", execute });
      },
      "Recovery",
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]).toEqual([
      "docker",
      ["synthetic"],
      { stdio: "ignore", timeout: 120000 },
    ]);
    for (const phase of ["dump", "restore"])
      for (const state of ["started", "completed"]) {
        const file = options.folder + "/" + phase + "-" + state + ".json";
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        const value = JSON.parse(await fs.readFile(file, "utf8"));
        expect(value.state.toLowerCase()).toBe(state);
        expect(value.phase.toLowerCase()).toBe(phase);
        expect(Object.keys(value).sort()).toEqual([
          "phase",
          "recordedAt",
          "schemaVersion",
          "state",
        ]);
      }
    await assertPilotMaintenanceAccess(options.runtimeDirectory);
  });
});
it.each(["timeout", "exit", "throw", "checkpoint"])(
  "retains Recovery exclusion after %s and denies subsequent work",
  async (mode) => {
    await fixture(async (options) => {
      if (mode === "checkpoint")
        await fs.writeFile(options.folder + "/dump-completed.json", "existing", { mode: 0o600 });
      const execute = vi.fn(() => {
        if (mode === "throw") throw Error("private driver message");
        if (mode === "timeout") return { error: Error("private timeout"), status: null };
        return { status: mode === "exit" ? 1 : 0 };
      });
      await withPilotMaintenance(
        options.runtimeDirectory,
        async () => {
          await expect(runPilotRecoveryCommand({ ...options, execute })).rejects.toThrow(
            "RECOVERY_COMMAND_REVIEW_REQUIRED",
          );
          await expect(
            assertPilotMaintenanceAccess(options.runtimeDirectory, "start"),
          ).rejects.toThrow();
          await expect(
            withPilotMaintenance(options.runtimeDirectory, async () => "forbidden"),
          ).rejects.toThrow();
        },
        "Recovery",
      );
      await expect(assertPilotMaintenanceAccess(options.runtimeDirectory)).rejects.toThrow();
      expect(
        JSON.parse(await fs.readFile(options.runtimeDirectory + "/maintenance.lock", "utf8"))
          .operation,
      ).toBe("Recovery");
      expect(
        JSON.parse(await fs.readFile(options.folder + "/dump-started.json", "utf8")).state,
      ).toBe("Started");
      if (mode !== "checkpoint")
        await expect(fs.stat(options.folder + "/dump-completed.json")).rejects.toMatchObject({
          code: "ENOENT",
        });
    });
  },
);
it("rejects execution outside Recovery ownership and from a Stop owner", async () => {
  await fixture(async (options) => {
    const execute = vi.fn(() => ({ status: 0 }));
    await expect(runPilotRecoveryCommand({ ...options, execute })).rejects.toThrow();
    await withPilotMaintenance(
      options.runtimeDirectory,
      async () => {
        await expect(runPilotRecoveryCommand({ ...options, execute })).rejects.toThrow();
      },
      "Stop",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(await fs.readdir(options.folder)).toEqual([]);
  });
});
