// WP-2423 (2026-10-18, DEC-PILOT-ALERTS-BACKUP correction 1): the planned-update marker.
//
// The deploy procedure writes `<runtime>/ops/maintenance.json` before it recreates the pilot
// container and removes it once the store pages answer again. While the marker is valid, the
// monitor holds new "store system down" alerts (entries, supervisor, services) and the Home shows
// a calm "System update in progress" notice instead; the window is at most 15 minutes from its
// start, so a forgotten marker can never hide a real outage for longer. Dependency-free.
import fs from "node:fs/promises";
import path from "node:path";
import {
  PLANNED_MAINTENANCE_FILE,
  ensureOpsDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./pilot-ops-files.mjs";

const MINUTE = 60_000;
export const PLANNED_MAINTENANCE_MAX_MINUTES = 15;
const MAX_MS = PLANNED_MAINTENANCE_MAX_MINUTES * MINUTE;
// Operator notes stay in the 0600 marker (and `status`); they never reach the board, messages or log.
const NOTE = /^[\p{L}\p{N}][\p{L}\p{N} .,:;#()/_+-]{0,79}$/u;
const instant = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));

/**
 * The marker's window when it is in force at `now`, otherwise null. A marker that is malformed,
 * longer than 15 minutes, starts in the future or has expired is never honoured.
 */
export function activePlannedMaintenance(marker, now) {
  if (
    marker === null ||
    typeof marker !== "object" ||
    marker.schemaVersion !== 1 ||
    !instant(marker.startedAt) ||
    !instant(marker.expiresAt)
  )
    return null;
  const started = Date.parse(marker.startedAt),
    expires = Date.parse(marker.expiresAt);
  if (expires <= started || expires - started > MAX_MS) return null;
  if (now < started || now >= expires) return null;
  return { startedAt: marker.startedAt, expiresAt: marker.expiresAt };
}

/** The marker as stored: the parsed file, null when absent, "unreadable" when it cannot be read. */
export async function readPlannedMaintenance(runtimeDirectory) {
  try {
    return await readPrivateJson(path.join(runtimeDirectory, "ops", PLANNED_MAINTENANCE_FILE));
  } catch {
    return "unreadable";
  }
}

/** Writes (or replaces) the marker; the window starts now and lasts 1–15 minutes. */
export async function startPlannedMaintenance(
  runtimeDirectory,
  { reason, startedBy = "pilot operator", minutes = PLANNED_MAINTENANCE_MAX_MINUTES, now },
) {
  if (typeof reason !== "string" || !NOTE.test(reason))
    throw Error("PILOT_MAINTENANCE_REASON_INVALID");
  if (typeof startedBy !== "string" || !NOTE.test(startedBy) || startedBy.length > 40)
    throw Error("PILOT_MAINTENANCE_STARTED_BY_INVALID");
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > PLANNED_MAINTENANCE_MAX_MINUTES)
    throw Error("PILOT_MAINTENANCE_MINUTES_INVALID");
  const at = now ?? Date.now();
  const marker = {
    schemaVersion: 1,
    startedBy,
    reason,
    startedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + minutes * MINUTE).toISOString(),
  };
  const directory = await ensureOpsDirectory(runtimeDirectory);
  await writePrivateJson(path.join(directory, PLANNED_MAINTENANCE_FILE), marker);
  return marker;
}

/** Removes the marker; true when one was present. */
export async function endPlannedMaintenance(runtimeDirectory) {
  const directory = await ensureOpsDirectory(runtimeDirectory);
  try {
    await fs.unlink(path.join(directory, PLANNED_MAINTENANCE_FILE));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
