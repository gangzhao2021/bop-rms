import assert from "node:assert/strict";
import { writeFile, mkdir, lstat, realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { loadPilotInstallation } from "./pilot-installation.mjs";
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

async function privateDirectory(directory) {
  const stat = await lstat(directory);
  assert.equal(await realpath(directory), directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o777, 0o700);
}
async function protectedRead(root, file) {
  assert.equal(await realpath(file), file);
  assert.ok(file.startsWith(root + "/.local/"));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    assert.ok(st.isFile());
    assert.equal(st.uid, process.getuid());
    assert.equal(st.mode & 0o777, 0o600);
    assert.ok(st.size > 0 && st.size <= 1048576);
    const bytes = await handle.readFile();
    assert.equal(bytes.length, st.size);
    return bytes;
  } finally {
    await handle.close();
  }
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function backupPilotInstallation({
  root,
  directory,
  destination,
  requireDailySettlement = false,
}) {
  try {
    assert.ok(["development", "test"].includes(process.env.NODE_ENV));
    assert.equal(await realpath(root), root);
    assert.ok(directory.startsWith(root + "/.local/"));
    assert.ok(destination.startsWith(directory + "/"));
    await privateDirectory(directory);
    await privateDirectory(path.dirname(destination));
    const installation = await loadPilotInstallation(directory),
      customer = await installation.loadCustomerRuntime();
    const selected = [...names, ...customer.diningTableFiles];
    let coverage = requireDailySettlement;
    try {
      await lstat(path.join(directory, "daily-settlement-coverage.json"));
      coverage = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (coverage) {
      await installation.loadDailySettlementCoverage();
      selected.push("daily-settlement-coverage.json");
    }
    assert.equal(new Set(selected).size, selected.length);
    for (const name of selected) assert.equal(path.basename(name), name);
    const env = await protectedRead(root, path.join(directory, "environment.env"));
    const lines = env
      .toString()
      .split(/\r?\n/)
      .filter((line) => line.startsWith("BOP_RMS_POSTGRES_PASSWORD_FILE="));
    assert.equal(lines.length, 1);
    let value = lines[0].slice("BOP_RMS_POSTGRES_PASSWORD_FILE=".length);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    assert.ok(value && !/[\r\n\0]/.test(value));
    const sources = new Map(selected.map((name) => [name, path.join(directory, name)]));
    sources.set("migration-admin-password", path.resolve(root, value));
    await mkdir(destination, { mode: 0o700 });
    await privateDirectory(destination);
    const manifest = {
      schemaVersion: 1,
      sourceDatabase: installation.database,
      observedAt: new Date().toISOString(),
      files: [],
      externalExport: false,
    };
    for (const [name, source] of sources) {
      const bytes = await protectedRead(root, source);
      const target = path.join(destination, name);
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      assert.ok(bytes.equals(await protectedRead(root, target)));
      manifest.files.push({ name, source, sha256: digest(bytes), size: bytes.length });
    }
    await verifyPilotInstallationBackup({ root, destination, manifest });
    await writeFile(
      path.join(destination, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return manifest;
  } catch {
    throw Error("INSTALLATION_BACKUP_UNAVAILABLE");
  }
}
export async function verifyPilotInstallationBackup({ root, destination, manifest }) {
  try {
    await privateDirectory(destination);
    for (const file of manifest.files) {
      assert.equal(path.basename(file.name), file.name);
      assert.equal(digest(await protectedRead(root, file.source)), file.sha256);
      assert.equal(
        digest(await protectedRead(root, path.join(destination, file.name))),
        file.sha256,
      );
    }
  } catch {
    throw Error("INSTALLATION_BACKUP_CHANGED");
  }
}
