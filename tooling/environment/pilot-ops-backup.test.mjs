import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifyRestoreFailure,
  createDirectoryOffsiteTarget,
  decideBackupRun,
  decryptFile,
  emptyBackupStatus,
  encryptFile,
  productImageDirectory,
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
    await fs.writeFile(path.join(dumps, `${file}.media.tar`), "photos");
    await fs.writeFile(path.join(offsite, "db-20261001T083100Z.dump.media.tar.enc"), "old");
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
    // The product photos of the same runtime the pilot storage adapter writes.
    expect(script.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        "--media",
        path.join(".local/pilot-test", "media", "product-images"),
      ]),
    );
    expect(productImageDirectory(".local/pilot-v15")).toBe(".local/pilot-v15/media/product-images");
    expect(script.mock.calls[1][0][0]).toBe("drill");
    expect(next).toMatchObject({
      lastSuccessFile: file,
      lastSuccessLocalDate: "2026-10-15",
      restoreCheck: { result: "Matched", file },
      offsite: { result: "Copied", file },
    });
    expect((await fs.readdir(offsite)).sort()).toEqual(
      [
        "db-20261002T083100Z.dump.enc",
        `${file}.enc`,
        `${file}.manifest.json.enc`,
        `${file}.media.tar.enc`,
      ].sort(),
    );
    const restored = path.join(root, "restored.tar");
    await decryptFile(
      path.join(offsite, `${file}.media.tar.enc`),
      restored,
      Buffer.alloc(32, 1),
      `${file}.media.tar`,
    );
    expect(await fs.readFile(restored, "utf8")).toBe("photos");
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
  it("records the backup's own completion time, not the time the cycle started", async () => {
    const file = "bop_rms_pilot_v15-20261015T083100Z.dump";
    const finished = after + 17_000;
    const next = await runBackupCycle({
      now: after,
      clock: () => finished,
      runtimeDirectory: ".local/pilot-test",
      installation,
      backup: { ...backup, restoreCheck: false },
      status: emptyBackupStatus(),
      script: async () => ({
        ok: true,
        line: `PILOT_BACKUP_CREATED ${file} tables=1 rows=1 bytes=1`,
        reason: null,
      }),
    });
    expect(next.lastSuccessAt).toBe(new Date(finished).toISOString());
    expect(next.lastAttempt.at).toBe(new Date(after).toISOString());
  });
  it("records why the restore failed (exit status, error class, table) without data values", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-restore-"));
    const file = "bop_rms_pilot_v15-20261015T083100Z.dump";
    const errorsFile = "drill-20261015T083400Z.restore-errors.txt";
    await fs.writeFile(
      path.join(dir, errorsFile),
      [
        'pg_restore: error: could not execute query: ERROR:  insert or update on table "payment_attempt" violates foreign key constraint "payment_attempt_order_fk"',
        'DETAIL:  Key (order_id)=(4f1c-secret-value) is not present in table "order_header".',
        "Command was: ALTER TABLE ONLY rms_payment.payment_attempt",
        "    ADD CONSTRAINT payment_attempt_order_fk FOREIGN KEY (order_id) REFERENCES rms_ordering.order_header(order_id);",
        "pg_restore: from TOC entry 6070; 2606 420397 FK CONSTRAINT payment_attempt payment_attempt_order_fk bop_rms_admin",
      ].join("\n"),
    );
    const log = vi.fn();
    const next = await runBackupCycle({
      now: after,
      runtimeDirectory: ".local/pilot-test",
      installation,
      backup: { ...backup, directory: dir },
      status: emptyBackupStatus(),
      log,
      script: async (args) =>
        args[0] === "backup"
          ? { ok: true, line: `PILOT_BACKUP_CREATED ${file} tables=1 rows=1 bytes=1`, reason: null }
          : { ok: false, line: "", reason: "restore", restoreExit: "1", restoreErrors: errorsFile },
    });
    const reason =
      "restore exit=1 class=foreign_key_violation sqlstate=23503 item=FK_CONSTRAINT table=rms_payment.payment_attempt";
    expect(next.restoreCheck).toMatchObject({ result: "Failed", file, reason });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "restore_check_failed", reason }),
    );
    expect(JSON.stringify(next)).not.toMatch(/secret-value|order_fk/u);
    await fs.rm(dir, { recursive: true });
  });
});

describe("WP-2423 Q13 restore check failure reasons", () => {
  it("names the error class but never values from the message", () => {
    expect(
      classifyRestoreFailure({
        exit: "1",
        errors:
          'pg_restore: error: COPY failed for table "menu_item": ERROR:  invalid input syntax for type integer: "Mrs Smith 555-0100"\nCONTEXT:  COPY menu_item, line 3',
      }),
    ).toBe("restore exit=1 class=invalid_text_representation sqlstate=22P02");
    expect(
      classifyRestoreFailure({
        exit: "1",
        errors:
          'pg_restore: error: could not execute query: ERROR:  role "bop_rms_other" does not exist\nCommand was: ALTER TABLE rms_catalog.menu_item OWNER TO bop_rms_other;',
      }),
    ).toBe("restore exit=1 class=undefined_role sqlstate=42704 table=rms_catalog.menu_item");
    expect(classifyRestoreFailure({ exit: "137", errors: "" })).toBe(
      "restore exit=137 class=no_message",
    );
    expect(classifyRestoreFailure({ exit: "1", errors: "ERROR:  something new: 'x'" })).toBe(
      "restore exit=1 class=other",
    );
    expect(
      classifyRestoreFailure({ exit: null, differingTable: "rms_ordering.order_header" }),
    ).toBe("rows differ table=rms_ordering.order_header");
    expect(classifyRestoreFailure({ exit: null })).toBeNull();
  });
});

describe("WP-2423 Q13 pilot-backup.sh drill with the local client (fake PostgreSQL programs)", () => {
  // Fake pg_dump/pg_restore/psql: the "dump" is plain COPY text, so the script's own row counting
  // works on it. The restore never reads its input (like pg_restore after the last item it needs).
  const fakes = {
    pg_dump: `#!/bin/sh\nhead -c 2000000 /dev/zero | tr '\\0' 'x' >/dev/null\nprintf 'COPY rms_catalog.menu_item (id) FROM stdin;\\n1\\n2\\n\\\\.\\n'\nif [ -n "$FAKE_PHOTO" ]; then printf 'COPY bop_media.product_image (image_id, renditions_json) FROM stdin;\\n7\\t[{"path": "/media/images/%s"}]\\n\\\\.\\n' "$FAKE_PHOTO"; fi\nhead -c 3000000 /dev/zero | tr '\\0' '#'\n`,
    pg_restore: `#!/bin/sh\ncase " $* " in *" --data-only "*) cat; exit 0;; esac\nif [ -n "$FAKE_RESTORE_ERROR" ]; then echo "pg_restore: error: could not execute query: ERROR:  permission denied for schema rms_catalog" >&2; echo "Command was: ALTER TABLE ONLY rms_catalog.menu_item OWNER TO x;" >&2; exit 1; fi\nexit 0\n`,
    psql: `#!/bin/sh\ncase "$*" in *"FROM ONLY"*) printf 'SET\\nrms_catalog.menu_item\\t%s\\n' "\${FAKE_ROWS:-2}"; case "$*" in *product_image*) printf 'bop_media.product_image\\t1\\n';; esac;; *pg_database*) echo 0;; *server_version*) echo 18.4;; esac\nexit 0\n`,
  };
  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ops-drill-"));
    await fs.mkdir(path.join(root, "bin"));
    for (const [name, body] of Object.entries(fakes))
      await fs.writeFile(path.join(root, "bin", name), body, { mode: 0o755 });
    await fs.writeFile(path.join(root, "password"), "not-a-real-password\n", { mode: 0o600 });
    return root;
  }
  const run = (root, args, env = {}, extra = []) =>
    new Promise((resolve) => {
      execFile(
        "bash",
        [
          path.resolve("tooling/environment/pilot-backup.sh"),
          ...args,
          "--client",
          "local",
          "--port",
          "55435",
          "--database",
          "bop_rms_pilot_test",
          "--user",
          "bop_rms_admin",
          "--password-file",
          path.join(root, "password"),
          "--dir",
          path.join(root, "backups"),
          ...extra,
        ],
        { env: { PATH: `${path.join(root, "bin")}:${process.env.PATH}`, ...env } },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
  it("matches when pg_restore succeeds without reading the whole backup, and reports failures", async () => {
    const root = await setup();
    const created = await run(root, ["backup"]);
    expect(created.stdout).toMatch(/^PILOT_BACKUP_CREATED \S+ tables=1 rows=2 /u);
    const matched = await run(root, ["drill"]);
    expect(matched.stdout).toMatch(/^PILOT_RESTORE_DRILL_MATCHED \S+ tables=1 rows=2 /u);
    const failed = await run(root, ["drill"], { FAKE_RESTORE_ERROR: "1" });
    expect(failed.code).toBe(1);
    const errorsFile = /PILOT_RESTORE_FAILED exit=1 errors=(\S+)/u.exec(failed.stderr)?.[1];
    expect(failed.stderr).not.toMatch(/permission denied/u);
    expect(
      classifyRestoreFailure({
        exit: "1",
        errors: await fs.readFile(path.join(root, "backups", errorsFile), "utf8"),
      }),
    ).toBe(
      "restore exit=1 class=insufficient_privilege sqlstate=42501 table=rms_catalog.menu_item",
    );
    const differs = await run(root, ["drill"], { FAKE_ROWS: "1" });
    expect(differs.stderr).toMatch(/PILOT_RESTORE_DIFFERS table=rms_catalog\.menu_item/u);
    await fs.rm(root, { recursive: true });
  });
  // A content-addressed photo file like the pilot storage adapter writes (<sha256>.<ext>).
  async function photo(directory, bytes) {
    const name = createHash("sha256").update(bytes).digest("hex") + ".webp";
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, name), bytes);
    return name;
  }
  it("backs up the product photos with the dump and the drill reproduces every referenced file", async () => {
    const root = await setup();
    const media = path.join(root, "runtime", "media", "product-images");
    const referenced = await photo(media, "rendition-a");
    await photo(media, "rendition-b");
    await fs.writeFile(path.join(media, `.${referenced}.0123456789abcdef.tmp`), "partial");
    const env = { FAKE_PHOTO: referenced };
    const created = await run(root, ["backup"], env, ["--media", media]);
    expect(created.stdout).toMatch(
      /^PILOT_BACKUP_CREATED \S+ tables=2 rows=3 \S+ media=2 mediaMissing=0$/mu,
    );
    const dump = /PILOT_BACKUP_CREATED (\S+) /u.exec(created.stdout)[1];
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, "backups", `${dump}.manifest.json`), "utf8"),
    );
    expect(manifest).toMatchObject({
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      mediaFile: `${dump}.media.tar`,
      mediaFiles: 2,
      mediaReferenced: 1,
      mediaMissing: 0,
      tables: { "bop_media.product_image": 1, "rms_catalog.menu_item": 2 },
    });
    // Losing the live photos afterwards does not matter: the drill restores from the archive.
    await fs.rm(media, { recursive: true });
    const matched = await run(root, ["drill"], env, ["--media", media]);
    expect(matched.stdout).toMatch(/^PILOT_RESTORE_DRILL_MATCHED \S+ tables=2 rows=3 media=2 /u);
    const archive = path.join(root, "backups", `${dump}.media.tar`);
    const bytes = await fs.readFile(archive);
    bytes[bytes.indexOf("rendition-a")] ^= 1;
    await fs.writeFile(archive, bytes);
    const tampered = await run(root, ["drill"], env);
    expect(tampered.stderr).toMatch(/media checksum mismatch/u);
    // Even with a manifest that matches the changed archive, a file whose bytes no longer hash to
    // its name is refused.
    const manifestFile = path.join(root, "backups", `${dump}.manifest.json`);
    await fs.writeFile(
      manifestFile,
      (await fs.readFile(manifestFile, "utf8")).replace(
        manifest.mediaSha256,
        createHash("sha256").update(bytes).digest("hex"),
      ),
    );
    const altered = await run(root, ["drill"], env);
    expect(altered.stderr).toMatch(/PILOT_BACKUP_UNAVAILABLE: media differs/u);
    expect(
      (await fs.readdir(path.join(root, "backups"))).some((n) => n.startsWith("drill-media")),
    ).toBe(false);
    await fs.rm(root, { recursive: true });
  });
  it("backs up a store without photos yet, and fails the drill when referenced photos are missing", async () => {
    const root = await setup();
    const media = path.join(root, "runtime", "media", "product-images");
    const none = await run(root, ["backup"], {}, ["--media", media]);
    expect(none.stdout).toMatch(/ media=0 mediaMissing=0$/mu);
    expect((await run(root, ["drill"])).stdout).toMatch(
      /^PILOT_RESTORE_DRILL_MATCHED .* media=0 /u,
    );
    const lost = "f".repeat(64) + ".jpg";
    // The database references a photo whose file is gone: the dump is still kept (orders and
    // payments keep being backed up) and the restore check fails so the operator is alerted.
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1100));
    const missing = await run(root, ["backup"], { FAKE_PHOTO: lost }, ["--media", media]);
    expect(missing.stdout).toMatch(/ media=0 mediaMissing=1$/mu);
    const failed = await run(root, ["drill"], { FAKE_PHOTO: lost });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/PILOT_RESTORE_MEDIA_MISSING files=1/u);
    expect(failed.stderr).toMatch(/PILOT_BACKUP_UNAVAILABLE: media missing/u);
    await fs.symlink(root, path.join(root, "link"));
    const refused = await run(root, ["backup"], {}, ["--media", path.join(root, "link")]);
    expect(refused.stderr).toMatch(/PILOT_BACKUP_UNAVAILABLE: media dir/u);
    await fs.rm(root, { recursive: true });
  });
});
