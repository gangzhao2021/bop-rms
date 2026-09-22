import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  writePilotResumeOwner,
  readPilotResumeOwner,
  removePilotResumeOwner,
  assertPilotResumeOwner,
} from "./pilot-recovery-resume-owner.mjs";
async function fixture(work) {
  const runtime = ".local/resume-owner-" + randomUUID();
  const root = path.resolve(runtime),
    control = path.join(root, "recovery-resume.lock");
  await fs.mkdir(root, { mode: 0o700 });
  try {
    const lease = { operation: "Recovery", pid: process.pid };
    const bytes = JSON.stringify(lease) + "\n";
    await fs.writeFile(path.join(root, "maintenance.lock"), bytes, { mode: 0o600 });
    await fs.mkdir(path.join(root, "recovery-test"), { mode: 0o700 });
    const digest = createHash("sha256").update(bytes).digest("hex");
    await work({ runtime, root, control, lease, digest });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
it("distinguishes absent, unrecorded and active control without removing it", () =>
  fixture(async (f) => {
    expect(await readPilotResumeOwner(f.runtime)).toEqual({ state: "NoResumeControl" });
    await fs.mkdir(f.control, { mode: 0o700 });
    expect(await readPilotResumeOwner(f.runtime)).toMatchObject({
      state: "OwnerUnrecordedReviewRequired",
      controlRetained: true,
    });
    const owner = await writePilotResumeOwner(f.control, "recovery-test", f.digest);
    expect((await fs.stat(owner.file)).mode & 0o777).toBe(0o600);
    expect(await readPilotResumeOwner(f.runtime)).toEqual({
      state: "OwnerActive",
      label: "recovery-test",
      controlRetained: true,
    });
    expect(await fs.readFile(owner.file)).toEqual(owner.bytes);
    await removePilotResumeOwner(owner);
    expect((await fs.stat(f.control)).isDirectory()).toBe(true);
  }));
it("identifies an actual exited child and preserves its recorded identity", () =>
  fixture(async (f) => {
    await fs.mkdir(f.control, { mode: 0o700 });
    const script = `import {writePilotResumeOwner} from "./tooling/environment/pilot-recovery-resume-owner.mjs"; await writePilotResumeOwner(process.argv[1],"recovery-test",process.argv[2]);`;
    await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      script,
      f.control,
      f.digest,
    ]);
    const bytes = await fs.readFile(path.join(f.control, "owner.json"));
    expect(await readPilotResumeOwner(f.runtime)).toMatchObject({
      state: "OwnerExitedReviewRequired",
      controlRetained: true,
    });
    expect(await fs.readFile(path.join(f.control, "owner.json"))).toEqual(bytes);
  }));
it.each(["started", "boot"])("does not treat a different %s identity as active", (mode) =>
  fixture(async (f) => {
    await fs.mkdir(f.control, { mode: 0o700 });
    const owner = await writePilotResumeOwner(f.control, "recovery-test", f.digest);
    const value = JSON.parse(owner.bytes);
    if (mode === "started") value.started = "0";
    else value.bootId = "00000000-0000-0000-0000-000000000000";
    await fs.writeFile(owner.file, JSON.stringify(value), { mode: 0o600 });
    expect(await readPilotResumeOwner(f.runtime)).toMatchObject({
      state:
        mode === "started" ? "OwnerIdentityChangedReviewRequired" : "OwnerExitedReviewRequired",
      controlRetained: true,
    });
    await expect(removePilotResumeOwner(owner)).rejects.toThrow();
    expect((await fs.stat(owner.file)).isFile()).toBe(true);
  }),
);
it("refuses altered metadata and never removes it on cleanup", () =>
  fixture(async (f) => {
    await fs.mkdir(f.control, { mode: 0o700 });
    const owner = await writePilotResumeOwner(f.control, "recovery-test", f.digest);
    await fs.writeFile(owner.file, "{}", { mode: 0o600 });
    await expect(readPilotResumeOwner(f.runtime)).rejects.toThrow();
    await expect(assertPilotResumeOwner(owner)).rejects.toThrow();
    await expect(removePilotResumeOwner(owner)).rejects.toThrow();
    expect(await fs.readFile(owner.file, "utf8")).toBe("{}");
  }));
it("refuses symlinked or public owner metadata", () =>
  fixture(async (f) => {
    await fs.mkdir(f.control, { mode: 0o700 });
    const owner = await writePilotResumeOwner(f.control, "recovery-test", f.digest);
    await fs.chmod(owner.file, 0o644);
    await expect(readPilotResumeOwner(f.runtime)).rejects.toThrow();
    await fs.chmod(owner.file, 0o600);
    await fs.rename(owner.file, path.join(f.control, "retained.json"));
    await fs.symlink(path.join(f.control, "retained.json"), owner.file);
    await expect(readPilotResumeOwner(f.runtime)).rejects.toThrow();
    expect((await fs.lstat(owner.file)).isSymbolicLink()).toBe(true);
  }));

it.each(["none", "started", "completed", "released"])(
  "diagnoses exited controller stage %s without mutation",
  (mode) =>
    fixture(async (f) => {
      await fs.mkdir(f.control, { mode: 0o700 });
      const owner = await writePilotResumeOwner(f.control, "recovery-test", f.digest);
      const value = JSON.parse(owner.bytes);
      value.bootId = "00000000-0000-0000-0000-000000000000";
      await fs.writeFile(owner.file, JSON.stringify(value), { mode: 0o600 });
      const record = (state) => ({
        schemaVersion: 1,
        state,
        recordedAt: "2026-09-22T00:00:00.000Z",
        leaseSha256: f.digest,
        originalLease: f.lease,
        targetRestorationVerified: false,
      });
      if (mode !== "none")
        await fs.writeFile(
          path.join(f.root, "recovery-test/source-resume-started.json"),
          JSON.stringify(record("Started")),
          { mode: 0o600 },
        );
      if (["completed", "released"].includes(mode))
        await fs.writeFile(
          path.join(f.root, "recovery-test/source-resume-completed.json"),
          JSON.stringify(record("Completed")),
          { mode: 0o600 },
        );
      if (mode === "released") await fs.unlink(path.join(f.root, "maintenance.lock"));
      const before = await fs.readFile(owner.file);
      expect(await readPilotResumeOwner(f.runtime)).toMatchObject({
        state: "OwnerExitedReviewRequired",
        phase:
          mode === "none"
            ? "BeforeStartupReviewRequired"
            : mode === "started"
              ? "StartupInterruptedReviewRequired"
              : "CompletionRecordedReviewRequired",
        maintenanceLease: mode === "released" ? "AbsentAfterCompletionRecord" : "OriginalPresent",
        controlRetained: true,
      });
      expect(await fs.readFile(owner.file)).toEqual(before);
    }),
);
it.each([
  "orphan-completed",
  "wrong-hash",
  "changed-lease",
  "missing-lease",
  "linked-marker",
  "public-marker",
])("refuses inconsistent exited evidence %s", (mode) =>
  fixture(async (f) => {
    await fs.mkdir(f.control, { mode: 0o700 });
    const owner = await writePilotResumeOwner(f.control, "recovery-test", f.digest);
    const value = JSON.parse(owner.bytes);
    value.bootId = "00000000-0000-0000-0000-000000000000";
    await fs.writeFile(owner.file, JSON.stringify(value), { mode: 0o600 });
    const marker = path.join(
      f.root,
      "recovery-test/source-resume-" +
        (mode === "orphan-completed" ? "completed" : "started") +
        ".json",
    );
    await fs.writeFile(
      marker,
      JSON.stringify({
        schemaVersion: 1,
        state: mode === "orphan-completed" ? "Completed" : "Started",
        recordedAt: "2026-09-22T00:00:00.000Z",
        leaseSha256: mode === "wrong-hash" ? "a".repeat(64) : f.digest,
        originalLease: f.lease,
        targetRestorationVerified: false,
      }),
      { mode: 0o600 },
    );
    if (mode === "changed-lease") await fs.appendFile(path.join(f.root, "maintenance.lock"), " ");
    if (mode === "missing-lease") await fs.unlink(path.join(f.root, "maintenance.lock"));
    if (mode === "public-marker") await fs.chmod(marker, 0o644);
    if (mode === "linked-marker") {
      await fs.rename(marker, marker + ".original");
      await fs.symlink(marker + ".original", marker);
    }
    const before = await fs.readFile(owner.file);
    await expect(readPilotResumeOwner(f.runtime)).rejects.toThrow();
    expect(await fs.readFile(owner.file)).toEqual(before);
  }),
);

it("reads the selected retry attempt instead of old phase records", () =>
  fixture(async (f) => {
    await fs.mkdir(f.control, { mode: 0o700 });
    const attempt = "resume-attempt-" + randomUUID();
    const base = path.join(f.root, "recovery-test");
    await fs.mkdir(path.join(base, attempt), { mode: 0o700 });
    await fs.writeFile(
      path.join(base, "source-resume-started.json"),
      "old evidence is not the current attempt",
      { mode: 0o600 },
    );
    const owner = await writePilotResumeOwner(f.control, "recovery-test", f.digest, attempt);
    const value = JSON.parse(owner.bytes);
    value.bootId = "00000000-0000-0000-0000-000000000000";
    await fs.writeFile(owner.file, JSON.stringify(value), { mode: 0o600 });
    expect(await readPilotResumeOwner(f.runtime)).toMatchObject({
      state: "OwnerExitedReviewRequired",
      phase: "BeforeStartupReviewRequired",
      maintenanceLease: "OriginalPresent",
    });
    value.attempt = "../outside";
    await fs.writeFile(owner.file, JSON.stringify(value), { mode: 0o600 });
    await expect(readPilotResumeOwner(f.runtime)).rejects.toThrow();
  }));
