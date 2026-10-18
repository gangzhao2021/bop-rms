import process from "node:process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readPilotMaintenanceStatus } from "./pilot-maintenance-status.mjs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { assertPilotMaintenanceAccess, withPilotMaintenance } from "./pilot-maintenance.mjs";
import { acquirePilotSupervisorLease } from "./pilot-supervisor.mjs";
import { runPilotService } from "./pilot-service.mjs";
it("holds exclusion across awaits, permits nested owner work and denies unrelated start", async () => {
  const directory = ".local/maintenance-test-" + randomUUID();
  await fs.mkdir(directory, { mode: 0o700 });
  let release, entered;
  const gate = new Promise((r) => {
      release = r;
    }),
    inside = new Promise((r) => {
      entered = r;
    });
  try {
    const work = withPilotMaintenance(directory, async () => {
      await assertPilotMaintenanceAccess(directory);
      await withPilotMaintenance(directory, async () => assertPilotMaintenanceAccess(directory));
      entered();
      await gate;
      await assertPilotMaintenanceAccess(directory);
    });
    await inside;
    try {
      await expect(assertPilotMaintenanceAccess(directory)).rejects.toThrow(
        "PILOT_MAINTENANCE_ACTIVE",
      );
      await expect(runPilotService("start", "business-worker", directory)).rejects.toThrow(
        "PILOT_MAINTENANCE_ACTIVE",
      );
      await expect(acquirePilotSupervisorLease(directory)).rejects.toThrow(
        "PILOT_MAINTENANCE_IN_PROGRESS",
      );
    } finally {
      release();
      await work;
    }
    await assertPilotMaintenanceAccess(directory);
    await expect(fs.lstat(directory + "/maintenance.lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await fs.rmdir(directory);
  }
});
it("rejects existing supervisor and releases maintenance after callback failure", async () => {
  const directory = ".local/maintenance-test-" + randomUUID();
  await fs.mkdir(directory, { mode: 0o700 });
  let release;
  try {
    release = await acquirePilotSupervisorLease(directory);
    await expect(withPilotMaintenance(directory, async () => undefined)).rejects.toThrow(
      "PILOT_MAINTENANCE_ACTIVE",
    );
    await release();
    release = null;
    await expect(
      withPilotMaintenance(directory, async () => {
        throw Error("failure");
      }),
    ).rejects.toThrow("failure");
    await expect(fs.lstat(directory + "/maintenance.lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (release) await release();
    await fs.rmdir(directory);
  }
});

it("reports active and exited maintenance owners without clearing their lease", async () => {
  const directory = ".local/maintenance-status-" + randomUUID();
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    expect(await readPilotMaintenanceStatus(directory)).toEqual({ state: "NoMaintenanceLease" });
    await withPilotMaintenance(
      directory,
      async () => {
        expect(await readPilotMaintenanceStatus(directory)).toMatchObject({
          state: "OwnerActive",
          operation: "Stop",
          lockRetained: true,
        });
        const file = directory + "/maintenance.lock",
          lease = JSON.parse(await fs.readFile(file, "utf8"));
        await fs.writeFile(file, JSON.stringify({ ...lease, started: "0" }));
        expect(await readPilotMaintenanceStatus(directory)).toMatchObject({
          state: "OwnerIdentityChangedReviewRequired",
          lockRetained: true,
        });
        await fs.writeFile(file, JSON.stringify(lease));
      },
      "Stop",
    );
    const script = `import { withPilotMaintenance } from "./tooling/environment/pilot-maintenance.mjs";
      await withPilotMaintenance(process.argv[1], async () => process.exit(0), "Recovery");`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, directory], {
      stdio: "ignore",
    });
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    const before = await fs.readFile(directory + "/maintenance.lock", "utf8");
    expect(await readPilotMaintenanceStatus(directory)).toMatchObject({
      state: "OwnerExitedReviewRequired",
      operation: "Recovery",
      lockRetained: true,
    });
    await expect(assertPilotMaintenanceAccess(directory)).rejects.toThrow();
    expect(await fs.readFile(directory + "/maintenance.lock", "utf8")).toBe(before);
    await fs.writeFile(directory + "/maintenance.lock", JSON.stringify({ pid: process.pid }));
    await expect(readPilotMaintenanceStatus(directory)).rejects.toThrow();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
