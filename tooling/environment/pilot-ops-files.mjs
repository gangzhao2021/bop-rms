// WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): file layout and private file helpers shared by the
// operations monitor (writer) and the merchant Home read (reader). Dependency-free.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/** `<runtime>/ops/` holds monitor state; it never holds credentials. */
export const OPS_DIRECTORY = "ops";
export const ALERT_STATE_FILE = "alert-state.json";
export const ALERT_BOARD_FILE = "alert-board.json";
export const ALERT_LOG_FILE = "alerts.log";
export const BACKUP_STATUS_FILE = "backup-status.json";
export const BACKUP_REQUEST_FILE = "backup-request";
export const SUPERVISOR_HEALTH_FILE = "supervisor.health.json";
export const OPS_CONFIG_FILE = "ops.json";
/** WP-2423 (2026-10-18): the planned-update marker the deploy procedure writes. */
export const PLANNED_MAINTENANCE_FILE = "maintenance.json";
const MAX_JSON_BYTES = 256 * 1024;

const fail = (code) => {
  throw Error(code);
};
/** The private ops directory (0700, owned by this user, not a link); created when missing. */
export async function ensureOpsDirectory(runtimeDirectory) {
  const directory = path.join(runtimeDirectory, OPS_DIRECTORY);
  await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await assertPrivateDirectory(directory);
  return directory;
}
export async function assertPrivateDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  )
    fail("PILOT_OPS_DIRECTORY_INVALID");
}
/** Private JSON read: regular 0600 file, not a link, bounded. Null when it does not exist. */
export async function readPrivateJson(file, { maxBytes = MAX_JSON_BYTES } = {}) {
  let handle;
  try {
    handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      stat.size > maxBytes
    )
      fail("PILOT_OPS_FILE_INVALID");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
let sequence = 0;
/** Atomic private JSON write (temporary file + rename, 0600). */
export async function writePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.${++sequence}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}
/** Reader for the merchant Home: the monitor's published alert board, or null before its first run. */
export function createPilotAlertBoardReader(runtimeDirectory) {
  const file = path.join(runtimeDirectory, OPS_DIRECTORY, ALERT_BOARD_FILE);
  return () => readPrivateJson(file);
}
