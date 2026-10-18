import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { expect, it, vi } from "vitest";
import { withPilotMaintenance, assertPilotMaintenanceAccess } from "./pilot-maintenance.mjs";
import { clearStoppedPilotMaintenance } from "./pilot-maintenance-clear-stop.mjs";
async function fixture(work, operation = "Stop") {
  const directory = ".local/stop-recovery-test-" + randomUUID();
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const script = `import { withPilotMaintenance } from "./tooling/environment/pilot-maintenance.mjs"; await withPilotMaintenance(process.argv[1], async () => process.exit(0), process.argv[2]);`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, directory, operation],
      { stdio: "ignore" },
    );
    expect((await once(child, "exit"))[0]).toBe(0);
    await work(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
it("releases an actual exited Stop owner only after all services are confirmed stopped", async () => {
  await fixture(async (directory) => {
    const confirmStopped = vi.fn(async () => true);
    expect(await clearStoppedPilotMaintenance(directory, { confirmStopped })).toEqual({
      state: "StoppedMaintenanceReleased",
      servicesConfirmedStopped: 7,
      servicesStarted: false,
    });
    expect(confirmStopped.mock.calls.map(([v]) => v.service)).toEqual([
      "customer",
      "api",
      "business-worker",
      "kitchen-queue-worker",
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
    ]);
    await assertPilotMaintenanceAccess(directory);
    await expect(fs.lstat(directory + "/maintenance-clear-stop.lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
it.each(["Recovery", "Unspecified"])(
  "retains %s leases without invoking service checks",
  async (operation) => {
    await fixture(async (directory) => {
      const before = await fs.readFile(directory + "/maintenance.lock", "utf8"),
        confirmStopped = vi.fn(async () => true);
      await expect(clearStoppedPilotMaintenance(directory, { confirmStopped })).rejects.toThrow();
      expect(confirmStopped).not.toHaveBeenCalled();
      expect(await fs.readFile(directory + "/maintenance.lock", "utf8")).toBe(before);
    }, operation);
  },
);
it("refuses active Stop ownership", async () => {
  const directory = ".local/stop-recovery-test-" + randomUUID();
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    await withPilotMaintenance(
      directory,
      async () => {
        await expect(clearStoppedPilotMaintenance(directory)).rejects.toThrow();
      },
      "Stop",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
it.each(["running", "throws", "restart", "changed", "concurrent"])(
  "retains maintenance on %s",
  async (mode) => {
    await fixture(async (directory) => {
      const file = directory + "/maintenance.lock",
        before = await fs.readFile(file, "utf8");
      if (mode === "restart") await fs.mkdir(directory + "/api.restart-lock");
      if (mode === "concurrent") await fs.mkdir(directory + "/maintenance-clear-stop.lock");
      const confirmStopped = vi.fn(async () => {
        if (mode === "running") return false;
        if (mode === "throws") throw Error("synthetic check failed");
        if (mode === "changed") await fs.writeFile(file, before + " ");
        return true;
      });
      await expect(clearStoppedPilotMaintenance(directory, { confirmStopped })).rejects.toThrow();
      expect(await fs.readFile(file, "utf8")).toBe(mode === "changed" ? before + " " : before);
      await expect(assertPilotMaintenanceAccess(directory)).rejects.toThrow();
    });
  },
);

it("uses real process liveness to refuse a surviving service without signalling it", async () => {
  await fixture(async (directory) => {
    await fs.writeFile(directory + "/customer.pid", String(process.pid), { mode: 0o600 });
    const before = await fs.readFile(directory + "/maintenance.lock", "utf8");
    await expect(clearStoppedPilotMaintenance(directory)).rejects.toThrow();
    expect(await fs.readFile(directory + "/maintenance.lock", "utf8")).toBe(before);
  });
});

it("finishes a partial Stop in order with stop-only access and releases after independent confirmation", async () => {
  await fixture(async (directory) => {
    let calls = 0;
    const stopService = vi.fn(async (action, service, runtimeDirectory) => {
      expect(action).toBe("stop");
      expect(runtimeDirectory).toBe(directory);
      await assertPilotMaintenanceAccess(directory, "stop");
      await expect(assertPilotMaintenanceAccess(directory, "start")).rejects.toThrow();
      await expect(assertPilotMaintenanceAccess(directory, "restart")).rejects.toThrow();
      await expect(
        withPilotMaintenance(directory, async () => "unexpected nested execution"),
      ).rejects.toThrow();
      calls++;
      return { service, state: "stopped" };
    });
    const confirmStopped = vi.fn(async () => {
      expect(calls).toBe(7);
      return true;
    });
    await clearStoppedPilotMaintenance(directory, {
      finishStop: true,
      stopService,
      confirmStopped,
    });
    expect(stopService.mock.calls.map(([, name]) => name)).toEqual([
      "customer",
      "api",
      "business-worker",
      "kitchen-queue-worker",
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
    ]);
    expect(confirmStopped).toHaveBeenCalledTimes(7);
    await assertPilotMaintenanceAccess(directory, "start");
  });
});
it.each(["throw", "wrong-result"])(
  "retains original lease after partial %s and supports a subsequent explicit retry",
  async (mode) => {
    await fixture(async (directory) => {
      const before = await fs.readFile(directory + "/maintenance.lock", "utf8");
      const stopService = vi.fn(async (_action, service) => {
        if (service === "api") {
          if (mode === "throw") throw Error("synthetic stop failed");
          return { service, state: "running" };
        }
        return { service, state: "stopped" };
      });
      await expect(
        clearStoppedPilotMaintenance(directory, { finishStop: true, stopService }),
      ).rejects.toThrow();
      expect(stopService).toHaveBeenCalledTimes(2);
      expect(await fs.readFile(directory + "/maintenance.lock", "utf8")).toBe(before);
      await expect(assertPilotMaintenanceAccess(directory, "stop")).rejects.toThrow();
      await clearStoppedPilotMaintenance(directory, {
        finishStop: true,
        stopService: async (_action, service) => ({ service, state: "stopped" }),
        confirmStopped: async () => true,
      });
      await assertPilotMaintenanceAccess(directory);
    });
  },
);
it("refuses to signal a real live PID with the wrong service identity during finish-stop", async () => {
  await fixture(async (directory) => {
    await fs.writeFile(directory + "/customer.pid", String(process.pid), { mode: 0o600 });
    const before = await fs.readFile(directory + "/maintenance.lock", "utf8");
    await expect(clearStoppedPilotMaintenance(directory, { finishStop: true })).rejects.toThrow();
    expect(await fs.readFile(directory + "/maintenance.lock", "utf8")).toBe(before);
    await expect(fs.lstat(directory + "/customer.restart-lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
