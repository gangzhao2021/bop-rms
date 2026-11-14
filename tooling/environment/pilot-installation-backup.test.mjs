import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("./pilot-installation.mjs", () => ({
  loadPilotInstallation: async () => ({
    database: "pilot",
    loadCustomerRuntime: async () => ({ diningTableFiles: ["internal-test-dining-table.json"] }),
    loadDailySettlementCoverage: async () => ({}),
  }),
}));
import {
  backupPilotInstallation,
  verifyPilotInstallationBackup,
} from "./pilot-installation-backup.mjs";
const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  vi.stubEnv("NODE_ENV", "test");
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pilot-backup-"));
  roots.push(temporaryRoot);
  const root = await realpath(temporaryRoot);
  const directory = path.join(root, ".local/pilot");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const names = [
    "installation.json",
    "customer-runtime.json",
    "merchant-runtime.json",
    "business-worker.json",
    "kitchen-queue-worker.json",
    "dining-exception-worker.json",
    "internal-test-profile.json",
    "internal-test-menu.json",
    "internal-test-keys.json",
    "internal-test-workflow-Pickup.json",
    "internal-test-workflow-DineIn.json",
    "internal-test-workflow-AdditionalRelease.json",
    "cancellation-workflow-draft-result.json",
    "internal-test-inventory.json",
    "internal-test-merchant.json",
    "internal-test-task-queue.json",
    "internal-test-receipt-template.json",
    "api-password",
    "worker-password",
    "guest-abuse-pepper",
    "internal-test-dining-key",
    "internal-test-qr-key.pem",
    "customer-tls-key.pem",
    "customer-tls-cert.pem",
    "environment.env",
  ];
  for (const name of [
    ...names,
    "internal-test-dining-table.json",
    "daily-settlement-coverage.json",
    "admin-password",
  ])
    await writeFile(path.join(directory, name), name, { mode: 0o600 });
  await writeFile(
    path.join(directory, "environment.env"),
    "BOP_RMS_POSTGRES_PASSWORD_FILE=.local/pilot/admin-password\n",
  );
  return { root, directory, destination: path.join(directory, "backup") };
}
it("copies exact private bytes including daily coverage and external dependency mapping", async () => {
  const f = await fixture();
  const manifest = await backupPilotInstallation(f);
  expect(manifest.files.some((v) => v.name === "daily-settlement-coverage.json")).toBe(true);
  expect(manifest.files.find((v) => v.name === "migration-admin-password").source).toBe(
    path.join(f.directory, "admin-password"),
  );
  await verifyPilotInstallationBackup({ ...f, manifest });
  await expect(backupPilotInstallation(f)).rejects.toThrow("INSTALLATION_BACKUP_UNAVAILABLE");
});
it.each(["source", "backup"])("detects changed %s before paired completion", async (side) => {
  const f = await fixture();
  const manifest = await backupPilotInstallation(f);
  await writeFile(
    path.join(side === "source" ? f.directory : f.destination, "api-password"),
    "changed",
  );
  await expect(verifyPilotInstallationBackup({ ...f, manifest })).rejects.toThrow(
    "INSTALLATION_BACKUP_CHANGED",
  );
});
it("rejects a symbolic-link credential", async () => {
  const f = await fixture();
  const file = path.join(f.directory, "api-password");
  await rm(file);
  await symlink(path.join(f.directory, "worker-password"), file);
  await expect(backupPilotInstallation(f)).rejects.toThrow("INSTALLATION_BACKUP_UNAVAILABLE");
});
it("rejects public credential permissions", async () => {
  const f = await fixture();
  await chmod(path.join(f.directory, "worker-password"), 0o644);
  await expect(backupPilotInstallation(f)).rejects.toThrow("INSTALLATION_BACKUP_UNAVAILABLE");
});
it("rejects password dependency outside the private local root", async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, "outside"), "secret", { mode: 0o600 });
  await writeFile(
    path.join(f.directory, "environment.env"),
    "BOP_RMS_POSTGRES_PASSWORD_FILE=outside\n",
  );
  await expect(backupPilotInstallation(f)).rejects.toThrow("INSTALLATION_BACKUP_UNAVAILABLE");
});
