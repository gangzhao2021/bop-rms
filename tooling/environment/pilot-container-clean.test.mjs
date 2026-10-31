import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { expect, it } from "vitest";
import { runPilotService } from "./pilot-service.mjs";

/**
 * v15 2026-10-31: after a container restart a served Store's kitchen worker stayed down — its PID
 * file from the old container named a number that, in the new PID namespace, was another live
 * process, which the identity check rightly refused. The container start removes stale PID files
 * of every served Store as it does the installation's, and keeps maintenance and restart locks.
 */
it.skipIf(process.platform !== "linux")(
  "removes a Store's PID file that collides with a live unrelated process, so its worker can start",
  async () => {
    const runtimeDirectory = ".local/container-clean-" + randomUUID(),
      store = runtimeDirectory + "/stores/demo-2";
    const directory = path.resolve(runtimeDirectory);
    await fs.mkdir(store, { recursive: true, mode: 0o700 });
    await fs.chmod(runtimeDirectory, 0o700);
    try {
      await fs.writeFile(
        runtimeDirectory + "/stores.json",
        JSON.stringify({ schemaVersion: 1, stores: ["stores/demo-2"] }),
        { mode: 0o600 },
      );
      // The old container's numbers: in this namespace they name this test's own process.
      for (const file of [
        store + "/kitchen-queue-worker.pid",
        runtimeDirectory + "/kitchen-queue-worker.pid",
        runtimeDirectory + "/supervisor.lock",
      ])
        await fs.writeFile(file, process.pid + "\n", { mode: 0o600 });
      // Kept: the installation's maintenance window and a Store worker's restart lock.
      await fs.mkdir(store + "/business-worker.restart-lock", { mode: 0o700 });
      // Before: the identity check refuses the unrelated process, so the worker is never handled.
      await expect(runPilotService("stop", "kitchen-queue-worker", store)).rejects.toThrow(
        "PILOT_PROCESS_UNAVAILABLE",
      );
      await fs.writeFile(runtimeDirectory + "/maintenance.lock", "{}", { mode: 0o600 });
      const cleaned = spawnSync("sh", ["tooling/environment/pilot-container-clean.sh", directory], {
        encoding: "utf8",
      });
      expect(cleaned.status).toBe(0);
      expect(cleaned.stdout.trim().split("\n").sort()).toEqual([
        "pilot-container-start: removing stale kitchen-queue-worker.pid",
        "pilot-container-start: removing stale stores/demo-2/kitchen-queue-worker.pid",
        "pilot-container-start: removing stale supervisor.lock",
      ]);
      await expect(fs.lstat(store + "/kitchen-queue-worker.pid")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await fs.lstat(store + "/business-worker.restart-lock")).isDirectory()).toBe(true);
      await fs.lstat(runtimeDirectory + "/maintenance.lock");
      await fs.rm(runtimeDirectory + "/maintenance.lock");
      // After: no PID names it, so it is confirmed stopped (start then launches it).
      expect(await runPilotService("stop", "kitchen-queue-worker", store)).toMatchObject({
        service: "kitchen-queue-worker",
        state: "stopped",
      });
    } finally {
      await fs.rm(runtimeDirectory, { recursive: true, force: true });
    }
  },
);
