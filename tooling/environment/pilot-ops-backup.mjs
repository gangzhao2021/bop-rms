// WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): scheduled backups for the pilot database. Daily at a
// configured Store-local quiet time: online dump (pilot-backup.sh, B3), restore check of that dump
// into a scratch database, encrypted off-site copy, retention. Results go to backup-status.json,
// which the monitor turns into alerts (failure, staleness, restore check, off-site copy).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import process from "node:process";
import { readPilotSecret } from "./pilot-ops-config.mjs";

export const BACKUP_MAX_ATTEMPTS_PER_DAY = 3;
export const BACKUP_RETRY_AFTER_MS = 30 * 60_000;
const DUMP = /^[a-z][a-z0-9_]{0,40}-[0-9]{8}T[0-9]{6}Z\.dump$/u;

/**
 * The product photo directory of a pilot runtime: the same `<runtime>/media/product-images` the
 * pilot storage adapter writes (pilot-merchant-composition.mjs) and the HTTPS entry serves
 * (pilot-https-entry.mjs). Published menus reference these files, so every backup includes them.
 */
export function productImageDirectory(runtimeDirectory) {
  return path.join(runtimeDirectory, "media", "product-images");
}

/** Store-local calendar date and minute of day for an instant (IANA zone, no host time zone). */
export function storeLocalParts(now, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(now))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function emptyBackupStatus() {
  return {
    schemaVersion: 1,
    lastSuccessAt: null,
    lastSuccessFile: null,
    lastSuccessLocalDate: null,
    lastAttempt: null,
    attempts: null,
    restoreCheck: null,
    offsite: null,
  };
}

/** Whether a backup should start now: once per Store-local day after the quiet time, with retries. */
export function decideBackupRun({ now, backup, status, requested = false }) {
  if (requested) return { run: true, reason: "Requested" };
  const local = storeLocalParts(now, backup.timeZone);
  const [hour, minute] = backup.localTime.split(":").map(Number);
  if (status.lastSuccessLocalDate === local.date) return { run: false, reason: "DoneToday" };
  if (local.minutes < hour * 60 + minute) return { run: false, reason: "BeforeQuietTime" };
  const attempts = status.attempts?.localDate === local.date ? status.attempts.count : 0;
  if (attempts >= BACKUP_MAX_ATTEMPTS_PER_DAY) return { run: false, reason: "AttemptsUsed" };
  if (status.lastAttempt && now - Date.parse(status.lastAttempt.at) < BACKUP_RETRY_AFTER_MS)
    return { run: false, reason: "RetryLater" };
  return { run: true, reason: "Scheduled" };
}

/** Runs pilot-backup.sh with the local PostgreSQL client; resolves with its single result line. */
export function runBackupScript(args, { cwd = process.cwd(), timeoutMs = 60 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["tooling/environment/pilot-backup.sh", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    });
    let out = "",
      err = "";
    child.stdout.on("data", (chunk) => (out = (out + chunk).slice(-4096)));
    child.stderr.on("data", (chunk) => (err = (err + chunk).slice(-4096)));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      // The script prints only file names, counts and fixed reasons (never credentials).
      const reason = /PILOT_BACKUP_UNAVAILABLE: ([a-z ]{1,40})/u.exec(err)?.[1] ?? null;
      const restore = RESTORE_FAILED.exec(err);
      const differs = RESTORE_DIFFERS.exec(err);
      resolve({
        ok: code === 0,
        line: out.trim().split("\n").at(-1) ?? "",
        reason,
        restoreExit: restore?.[1] ?? null,
        restoreErrors: restore?.[2] ?? null,
        differingTable: differs?.[1] ?? null,
      });
    });
    child.on("error", () => resolve({ ok: false, line: "", reason: "spawn" }));
  });
}

const RESTORE_FAILED =
  /PILOT_RESTORE_FAILED exit=((?:input-)?[0-9]{1,3}) errors=(drill-[0-9]{8}T[0-9]{6}Z\.restore-errors\.txt)/u;
const IDENTIFIER = "[a-z_][a-z0-9_]{0,62}";
const TABLE = new RegExp(`^${IDENTIFIER}\\.${IDENTIFIER}$`, "u");
const RESTORE_DIFFERS = new RegExp(
  `PILOT_RESTORE_DIFFERS table=(${IDENTIFIER}\\.${IDENTIFIER})`,
  "u",
);

// PostgreSQL server and pg_restore messages mapped to an error class and SQLSTATE. pg_restore does
// not print SQLSTATEs, so the class is recognised from the fixed message text; nothing else of
// the message (which can contain key values or input data) is recorded.
const RESTORE_ERROR_CLASSES = [
  [/violates foreign key constraint/u, "foreign_key_violation", "23503"],
  [/violates unique constraint|could not create unique index/u, "unique_violation", "23505"],
  [/violates not-null constraint/u, "not_null_violation", "23502"],
  [/violates check constraint/u, "check_violation", "23514"],
  [/violates exclusion constraint/u, "exclusion_violation", "23P01"],
  [/violates row-level security policy/u, "insufficient_privilege", "42501"],
  [
    /permission denied|must be owner of|must be superuser|must be member of|must be able to SET ROLE/u,
    "insufficient_privilege",
    "42501",
  ],
  [/role "[^"]*" does not exist/u, "undefined_role", "42704"],
  [/relation "[^"]*" does not exist/u, "undefined_table", "42P01"],
  [/schema "[^"]*" does not exist/u, "invalid_schema_name", "3F000"],
  [/function .* does not exist/u, "undefined_function", "42883"],
  [
    /extension "[^"]*" is not available|could not open extension control file/u,
    "undefined_file",
    "58P01",
  ],
  [/(?:type|operator|collation|text search \w+) .* does not exist/u, "undefined_object", "42704"],
  [/already exists/u, "duplicate_object", "42710"],
  [/statement timeout/u, "query_canceled", "57014"],
  [/lock timeout/u, "lock_not_available", "55P03"],
  [/transaction timeout|idle-in-transaction timeout/u, "transaction_timeout", "25P04"],
  [/deadlock detected/u, "deadlock_detected", "40P01"],
  [/out of shared memory/u, "out_of_shared_memory", "53200"],
  [/out of memory/u, "out_of_memory", "53200"],
  [/No space left on device|could not extend file/u, "disk_full", "53100"],
  [/invalid input syntax|invalid input value/u, "invalid_text_representation", "22P02"],
  [/value too long/u, "string_data_right_truncation", "22001"],
  [/syntax error/u, "syntax_error", "42601"],
  [
    /terminating connection|server closed the connection|connection to server|could not connect/u,
    "connection_failure",
    "08006",
  ],
  [/could not find block ID|out-of-order restore|non-seekable/u, "archive_out_of_order", null],
  [
    /unsupported version|did not find magic string|not a valid archive/u,
    "archive_unsupported",
    null,
  ],
  [/could not read from input file|unexpected end of file|corrupt/u, "archive_read_failed", null],
];
const TOC_ITEM =
  /from TOC entry [0-9]+; [0-9]+ [0-9]+ (TABLE DATA|TABLE|FK CONSTRAINT|CONSTRAINT|INDEX|TRIGGER|RULE|POLICY|ROW SECURITY|ACL|DEFAULT ACL|DEFAULT|SEQUENCE SET|SEQUENCE OWNED BY|SEQUENCE|FUNCTION|PROCEDURE|AGGREGATE|TYPE|DOMAIN|VIEW|MATERIALIZED VIEW DATA|MATERIALIZED VIEW|SCHEMA|EXTENSION|COMMENT|EVENT TRIGGER|PUBLICATION|SUBSCRIPTION|DATABASE PROPERTIES|DATABASE) /u;

/**
 * A safe one-line reason for a failed restore check: pg_restore's exit status, the class and
 * SQLSTATE of the first error, the kind of archive item and the schema.table it concerned. Data
 * values, constraint names and the rest of the message are never included.
 */
export function classifyRestoreFailure({ exit, errors = "", differingTable = null }) {
  if (differingTable !== null)
    return TABLE.test(differingTable) ? `rows differ table=${differingTable}` : "rows differ";
  if (exit === null) return null;
  const lines = errors.split("\n");
  const first =
    lines.find((line) => /\bERROR:/u.test(line)) ??
    lines.find((line) => /pg_restore: error:/u.test(line)) ??
    "";
  const parts = [`restore exit=${exit}`];
  const known = RESTORE_ERROR_CLASSES.find(([pattern]) => pattern.test(first));
  if (known) {
    parts.push(`class=${known[1]}`);
    if (known[2] !== null) parts.push(`sqlstate=${known[2]}`);
  } else parts.push(first === "" ? "class=no_message" : "class=other");
  const item = TOC_ITEM.exec(errors)?.[1];
  if (item) parts.push(`item=${item.replaceAll(" ", "_")}`);
  // "Command was: ALTER TABLE ONLY s.t ..." / "COPY s.t (...)" / 'table "s.t"' / 'relation "s.t"'.
  const table = new RegExp(
    `(?:Command was: (?:ALTER TABLE ONLY|ALTER TABLE|CREATE TABLE|COPY|CREATE POLICY \\S+ ON|CREATE TRIGGER \\S+ .*? ON|CREATE RULE \\S+ AS .*? TO|CREATE (?:UNIQUE )?INDEX \\S+ ON(?: ONLY)?|GRANT .*? ON TABLE) |(?:table|relation) ")(${IDENTIFIER}\\.${IDENTIFIER})\\b`,
    "u",
  ).exec(errors)?.[1];
  if (table && TABLE.test(table)) parts.push(`table=${table}`);
  return parts.join(" ");
}

async function readRestoreErrors(directory, name) {
  if (name === null) return "";
  try {
    const handle = await fs.open(path.join(directory, name), "r");
    try {
      const buffer = Buffer.alloc(16_384);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

// --- Encrypted off-site copies: AES-256-GCM, file name bound as associated data. ---
const MAGIC = Buffer.from("BOPRMSE1");
const NONCE = 12,
  TAG = 16;
export async function readOffsiteKey(runtimeDirectory, keyFile, read = readPilotSecret) {
  const hex = await read(runtimeDirectory, keyFile);
  if (!/^[0-9a-f]{64}$/u.test(hex)) throw Error("PILOT_OFFSITE_KEY_INVALID");
  return Buffer.from(hex, "hex");
}
/** A new random key file (64 hex characters, 0600); refuses to overwrite an existing key. */
export async function generateOffsiteKey(runtimeDirectory, keyFile) {
  await fs.writeFile(path.join(runtimeDirectory, keyFile), randomBytes(32).toString("hex") + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
export async function encryptFile(source, target, key, name) {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", key, nonce).setAAD(Buffer.from(name));
  const partial = target + ".partial";
  const out = createWriteStream(partial, { mode: 0o600, flags: "wx" });
  try {
    out.write(Buffer.concat([MAGIC, nonce]));
    await pipeline(createReadStream(source), cipher, out, { end: false });
    await new Promise((resolve, reject) =>
      out.end(cipher.getAuthTag(), (error) => (error ? reject(error) : resolve())),
    );
    await fs.rename(partial, target);
  } catch (error) {
    out.destroy();
    await fs.unlink(partial).catch(() => undefined);
    throw error;
  }
}
/** Decrypts and authenticates; the output appears only when the whole file verified. */
export async function decryptFile(source, target, key, name) {
  const handle = await fs.open(source, "r");
  let header, tag, size;
  try {
    size = (await handle.stat()).size;
    if (size < MAGIC.length + NONCE + TAG) throw Error("PILOT_OFFSITE_FILE_INVALID");
    header = Buffer.alloc(MAGIC.length + NONCE);
    await handle.read(header, 0, header.length, 0);
    tag = Buffer.alloc(TAG);
    await handle.read(tag, 0, TAG, size - TAG);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw Error("PILOT_OFFSITE_FILE_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length))
    .setAAD(Buffer.from(name))
    .setAuthTag(tag);
  const partial = target + ".partial";
  try {
    await pipeline(
      createReadStream(source, { start: header.length, end: size - TAG - 1 }),
      decipher,
      createWriteStream(partial, { mode: 0o600, flags: "wx" }),
    );
    await fs.rename(partial, target);
  } catch {
    await fs.unlink(partial).catch(() => undefined);
    throw Error("PILOT_OFFSITE_DECRYPT_FAILED");
  }
}

/**
 * The off-site target interface: `put(name, source)`, `list()`, `remove(name)`. The pilot ships a
 * directory target (an external drive or a folder a sync client copies off the host; content is
 * encrypted before it is written). S3-compatible object storage is an external gate (P4).
 */
export async function createDirectoryOffsiteTarget(directory, { forbidden = [] } = {}) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("PILOT_OFFSITE_TARGET_UNAVAILABLE");
  const real = await fs.realpath(directory);
  for (const inside of forbidden) {
    const other = await fs.realpath(inside).catch(() => null);
    if (other !== null && (real === other || real.startsWith(other + path.sep)))
      throw Error("PILOT_OFFSITE_TARGET_NOT_OFFSITE");
  }
  return Object.freeze({
    kind: "directory",
    async put(name, write) {
      await write(path.join(real, name));
    },
    async list() {
      return (await fs.readdir(real)).sort();
    },
    async remove(name) {
      await fs.rm(path.join(real, name), { force: true });
    },
  });
}

/**
 * One scheduled run. Every stage records its own outcome; a failed dump stops the run. Only file
 * names, counts and fixed reasons are recorded.
 */
export async function runBackupCycle({
  now,
  clock = Date.now,
  runtimeDirectory,
  installation,
  backup,
  status,
  script = runBackupScript,
  createTarget = createDirectoryOffsiteTarget,
  readKey = readOffsiteKey,
  log = () => undefined,
}) {
  const next = globalThis.structuredClone(status);
  const stamp = new Date(now).toISOString();
  const local = storeLocalParts(now, backup.timeZone);
  const count = next.attempts?.localDate === local.date ? next.attempts.count + 1 : 1;
  next.attempts = { localDate: local.date, count };
  const common = [
    "--client",
    "local",
    "--port",
    String(installation.port),
    "--database",
    installation.database,
    "--user",
    backup.role,
    "--password-file",
    path.join(runtimeDirectory, backup.passwordFile),
    "--dir",
    backup.directory,
    "--media",
    productImageDirectory(runtimeDirectory),
  ];
  const dump = await script(["backup", ...common, "--keep", String(backup.keep)]);
  const file = /^PILOT_BACKUP_CREATED (\S+) /u.exec(dump.line)?.[1] ?? null;
  if (!dump.ok || file === null || !DUMP.test(file)) {
    next.lastAttempt = {
      at: stamp,
      localDate: local.date,
      result: "Failed",
      stage: "dump",
      attemptsLeft: Math.max(0, BACKUP_MAX_ATTEMPTS_PER_DAY - count),
    };
    log({ event: "backup_failed", stage: "dump", reason: dump.reason });
    return next;
  }
  next.lastAttempt = {
    at: stamp,
    localDate: local.date,
    result: "Succeeded",
    stage: "dump",
    attemptsLeft: 0,
  };
  // The backup's own completion time (the cycle's start can be minutes earlier).
  next.lastSuccessAt = new Date(clock()).toISOString();
  next.lastSuccessFile = file;
  next.lastSuccessLocalDate = local.date;
  log({ event: "backup_created", file });
  if (backup.restoreCheck) {
    const drill = await script(["drill", ...common, "--backup", path.join(backup.directory, file)]);
    const matched = drill.ok && drill.line.startsWith("PILOT_RESTORE_DRILL_MATCHED ");
    const reason = matched
      ? null
      : (classifyRestoreFailure({
          exit: drill.restoreExit ?? null,
          errors: await readRestoreErrors(backup.directory, drill.restoreErrors ?? null),
          differingTable: drill.differingTable ?? null,
        }) ?? drill.reason);
    next.restoreCheck = {
      at: new Date(clock()).toISOString(),
      result: matched ? "Matched" : "Failed",
      file,
      ...(matched ? {} : { reason }),
    };
    log({
      event: matched ? "restore_check_matched" : "restore_check_failed",
      file,
      reason,
    });
    await pruneDrillRecords(backup.directory, backup.keep);
  }
  if (backup.offsite !== null) {
    try {
      const key = await readKey(runtimeDirectory, backup.offsite.keyFile);
      const target = await createTarget(backup.offsite.path, {
        forbidden: [runtimeDirectory, backup.directory],
      });
      // The dump, its manifest and its product photo archive, each encrypted the same way.
      for (const name of [file, `${file}.manifest.json`, `${file}.media.tar`])
        await target.put(`${name}.enc`, (destination) =>
          encryptFile(path.join(backup.directory, name), destination, key, name),
        );
      // Newest first by the UTC time in the name (names sort by database first).
      const stamp = (name) => /-([0-9]{8}T[0-9]{6}Z)\.dump\.enc$/u.exec(name)?.[1] ?? "";
      const copies = (await target.list())
        .filter((name) => stamp(name) !== "")
        .sort((a, b) => stamp(b).localeCompare(stamp(a)));
      for (const old of copies.slice(backup.offsite.keep)) {
        await target.remove(old);
        await target.remove(old.replace(/\.dump\.enc$/u, ".dump.manifest.json.enc"));
        await target.remove(old.replace(/\.dump\.enc$/u, ".dump.media.tar.enc"));
      }
      next.offsite = { at: new Date().toISOString(), result: "Copied", file };
      log({ event: "offsite_copied", file });
    } catch (error) {
      next.offsite = { at: new Date().toISOString(), result: "Failed", file };
      log({
        event: "offsite_failed",
        file,
        reason: /^PILOT_[A-Z_]+$/u.test(error?.message ?? "") ? error.message : "unavailable",
      });
    }
  }
  return next;
}
async function pruneDrillRecords(directory, keep) {
  const records = (await fs.readdir(directory).catch(() => []))
    .filter((name) => /^drill-[0-9]{8}T[0-9]{6}Z\.(?:json|restore-errors\.txt)$/u.test(name))
    .sort()
    .reverse();
  for (const old of records.slice(keep)) await fs.rm(path.join(directory, old), { force: true });
}
