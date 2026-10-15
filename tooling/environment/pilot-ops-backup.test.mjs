import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDirectoryOffsiteTarget,
  decideBackupRun,
  decryptFile,
  emptyBackupStatus,
  encryptFile,
  runBackupCycle,
  storeLocalParts,
} from "./pilot-ops-backup.mjs";

const backup = {
  role: "bop_rms_admin",
  passwordFile: "migration-admin-password",
  timeZone: "America/Toronto",
  localTime: "04:30",
  keep: 14,
  directory: ".local/pilot-test-backups",
  restoreCheck: true,
  offsite: null,
};
// 2026-10-15 04:29 and 04:31 in Toronto (EDT, UTC-4).
const before = Date.parse("2026-10-15T08:29:00.000Z");
const after = Date.parse("2026-10-15T08:31:00.000Z");

describe("WP-2423 Q13 backup schedule (Store-local quiet time)", () => {
  it("resolves the Store's local date and time, including across the date line in UTC", () => {
    expect(storeLocalParts(Date.parse("2026-10-15T03:30:00.000Z"), "America/Toronto")).toEqual({
      date: "2026-10-14",
      minutes: 23 * 60 + 30,
    });
  });
  it("runs once a day after the quiet time, retries a failure after 30 minutes, three tries a day", () => {
    const status = emptyBackupStatus();
    expect(decideBackupRun({ now: before, backup, status }).run).toBe(false);
    expect(decideBackupRun({ now: after, backup, status })).toEqual({
      run: true,
      reason: "Scheduled",
    });
    const failed = {
      ...status,
      attempts: { localDate: "2026-10-15", count: 1 },
      lastAttempt: { at: new Date(after).toISOString(), result: "Failed" },
    };
    expect(decideBackupRun({ now: after + 10 * 60_000, backup, status: failed }).reason).toBe(
      "RetryLater",
    );
    expect(decideBackupRun({ now: after + 31 * 60_000, backup, status: failed }).run).toBe(true);
    expect(
      decideBackupRun({
        now: after + 3 * 3600_000,
        backup,
        status: { ...failed, attempts: { localDate: "2026-10-15", count: 3 } },
      }).reason,
    ).toBe("AttemptsUsed");
    const done = { ...status, lastSuccessLocalDate: "2026-10-15" };
    expect(decideBackupRun({ now: after, backup, status: done }).reason).toBe("DoneToday");
    expect(decideBackupRun({ now: before, backup, status: done, requested: true }).run).toBe(true);
  });
});

describe("WP-2423 Q13 encrypted off-site copies", () => {
  it("round-trips a file, and refuses a tampered copy or a renamed one without writing output", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-enc-"));
    const key = Buffer.alloc(32, 7);
    const plain = path.join(dir, "db-20261015T083100Z.dump");
    await fs.writeFile(plain, Buffer.from("PGDMP".repeat(10_000)));
    const enc = path.join(dir, "copy.enc");
    await encryptFile(plain, enc, key, "db-20261015T083100Z.dump");
    expect((await fs.readFile(enc)).includes(Buffer.from("PGDMP"))).toBe(false);
    await decryptFile(enc, path.join(dir, "out.dump"), key, "db-20261015T083100Z.dump");
    expect((await fs.readFile(path.join(dir, "out.dump"))).equals(await fs.readFile(plain))).toBe(
      true,
    );
    await expect(
      decryptFile(enc, path.join(dir, "other.dump"), key, "another-name.dump"),
    ).rejects.toThrow("PILOT_OFFSITE_DECRYPT_FAILED");
    const bytes = await fs.readFile(enc);
    bytes[100] ^= 1;
    await fs.writeFile(path.join(dir, "tampered.enc"), bytes);
    await expect(
      decryptFile(
        path.join(dir, "tampered.enc"),
        path.join(dir, "t.dump"),
        key,
        "db-20261015T083100Z.dump",
      ),
    ).rejects.toThrow("PILOT_OFFSITE_DECRYPT_FAILED");
    await expect(fs.stat(path.join(dir, "t.dump"))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, "t.dump.partial"))).rejects.toThrow();
    await fs.rm(dir, { recursive: true });
  });
  it("refuses an off-site folder inside the runtime or backup directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-target-"));
    await fs.mkdir(path.join(dir, "inside"));
    await expect(
      createDirectoryOffsiteTarget(path.join(dir, "inside"), { forbidden: [dir] }),
    ).rejects.toThrow("PILOT_OFFSITE_TARGET_NOT_OFFSITE");
    await expect(createDirectoryOffsiteTarget(path.join(dir, "missing"))).rejects.toThrow();
    await fs.rm(dir, { recursive: true });
  });
});

describe("WP-2423 Q13 scheduled backup cycle", () => {
  const installation = { port: 55435, database: "bop_rms_pilot_v15" };
  it("dumps, checks the restore, copies off-site encrypted and keeps the newest copies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ops-cycle-"));
    const dumps = path.join(root, "backups");
    const offsite = path.join(root, "offsite");
    await fs.mkdir(dumps);
    await fs.mkdir(offsite);
    for (const name of ["db-20261001T083100Z.dump", "db-20261002T083100Z.dump"])
      await fs.writeFile(path.join(offsite, `${name}.enc`), "old");
    const file = "bop_rms_pilot_v15-20261015T083100Z.dump";
    await fs.writeFile(path.join(dumps, file), "dump");
    await fs.writeFile(path.join(dumps, `${file}.manifest.json`), "{}");
    const script = vi.fn(async (args) =>
      args[0] === "backup"
        ? { ok: true, line: `PILOT_BACKUP_CREATED ${file} tables=532 rows=1 bytes=4`, reason: null }
        : {
            ok: true,
            line: `PILOT_RESTORE_DRILL_MATCHED ${file} tables=532 rows=1 restoreSeconds=3`,
            reason: null,
          },
    );
    const next = await runBackupCycle({
      now: after,
      runtimeDirectory: ".local/pilot-test",
      installation,
      backup: {
        ...backup,
        directory: dumps,
        offsite: { kind: "directory", path: offsite, keyFile: "k", keep: 2 },
      },
      status: emptyBackupStatus(),
      script,
      readKey: async () => Buffer.alloc(32, 1),
    });
    expect(script.mock.calls[0][0]).toEqual(
      expect.arrayContaining(["backup", "--client", "local", "--port", "55435"]),
    );
    expect(script.mock.calls[0][0].join(" ")).not.toMatch(/password=|PGPASSWORD/u);
    expect(script.mock.calls[1][0][0]).toBe("drill");
    expect(next).toMatchObject({
      lastSuccessFile: file,
      lastSuccessLocalDate: "2026-10-15",
      restoreCheck: { result: "Matched", file },
      offsite: { result: "Copied", file },
    });
    expect((await fs.readdir(offsite)).sort()).toEqual(
      ["db-20261002T083100Z.dump.enc", `${file}.enc`, `${file}.manifest.json.enc`].sort(),
    );
    await fs.rm(root, { recursive: true });
  });
  it("records a failed dump with the tries left and does not touch restore check or off-site", async () => {
    const script = vi.fn(async () => ({ ok: false, line: "", reason: "pg_dump" }));
    const next = await runBackupCycle({
      now: after,
      runtimeDirectory: ".local/pilot-test",
      installation,
      backup,
      status: emptyBackupStatus(),
      script,
    });
    expect(next.lastAttempt).toMatchObject({ result: "Failed", stage: "dump", attemptsLeft: 2 });
    expect(next.lastSuccessAt).toBeNull();
    expect(script).toHaveBeenCalledTimes(1);
  });
  it("records a failed restore check and a failed off-site copy separately from the backup", async () => {
    const file = "bop_rms_pilot_v15-20261015T083100Z.dump";
    const next = await runBackupCycle({
      now: after,
      runtimeDirectory: ".local/pilot-test",
      installation,
      backup: {
        ...backup,
        directory: os.tmpdir(),
        offsite: { kind: "directory", path: "/nonexistent-offsite", keyFile: "k", keep: 2 },
      },
      status: emptyBackupStatus(),
      script: async (args) =>
        args[0] === "backup"
          ? { ok: true, line: `PILOT_BACKUP_CREATED ${file} tables=1 rows=1 bytes=1`, reason: null }
          : { ok: false, line: "", reason: "restored rows differ from backup" },
      readKey: async () => Buffer.alloc(32, 1),
    });
    expect(next.lastSuccessFile).toBe(file);
    expect(next.restoreCheck.result).toBe("Failed");
    expect(next.offsite.result).toBe("Failed");
  });
});
