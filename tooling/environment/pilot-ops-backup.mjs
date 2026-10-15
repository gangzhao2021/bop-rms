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
      resolve({ ok: code === 0, line: out.trim().split("\n").at(-1) ?? "", reason });
    });
    child.on("error", () => resolve({ ok: false, line: "", reason: "spawn" }));
  });
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
  next.lastSuccessAt = stamp;
  next.lastSuccessFile = file;
  next.lastSuccessLocalDate = local.date;
  log({ event: "backup_created", file });
  if (backup.restoreCheck) {
    const drill = await script(["drill", ...common, "--backup", path.join(backup.directory, file)]);
    const matched = drill.ok && drill.line.startsWith("PILOT_RESTORE_DRILL_MATCHED ");
    next.restoreCheck = {
      at: new Date().toISOString(),
      result: matched ? "Matched" : "Failed",
      file,
    };
    log({
      event: matched ? "restore_check_matched" : "restore_check_failed",
      file,
      reason: drill.reason,
    });
    await pruneDrillRecords(backup.directory, backup.keep);
  }
  if (backup.offsite !== null) {
    try {
      const key = await readKey(runtimeDirectory, backup.offsite.keyFile);
      const target = await createTarget(backup.offsite.path, {
        forbidden: [runtimeDirectory, backup.directory],
      });
      for (const name of [file, `${file}.manifest.json`])
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
    .filter((name) => /^drill-[0-9]{8}T[0-9]{6}Z\.json$/u.test(name))
    .sort()
    .reverse();
  for (const old of records.slice(keep)) await fs.rm(path.join(directory, old), { force: true });
}
