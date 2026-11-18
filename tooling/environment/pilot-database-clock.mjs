import console from "node:console";
import { clearInterval, setInterval } from "node:timers";

/**
 * WP-2423: the database clock is the one time authority. Application code stamps instants with its
 * own clock and the owners compare them with `clock_timestamp()`, in hundreds of places, so an API
 * host a few milliseconds ahead of the database has its writes refused at random. Each service
 * process therefore reads the time from the database's clock, shifted by the measured difference.
 *
 * The estimate is a lower bound: what the database said is taken as the time the answer arrived,
 * so an application instant is never later than the database's. A difference above the allowance
 * means a clock is wrong, not that hosts drifted: it is reported and not followed.
 */
export const pilotClockMaximumOffsetMs = 2000;
const syncIntervalMs = 60_000;
const samples = 3;
const SystemDate = globalThis.Date;
let offsetMs = 0;
let latest = 0;
let timer = null;
let reportedTooLarge = false;
let reportedAligned = false;

function alignedNow() {
  latest = Math.max(latest, SystemDate.now() + offsetMs);
  return latest;
}
const AlignedDate = new Proxy(SystemDate, {
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length === 0 ? [alignedNow()] : args, newTarget),
  apply: () => new SystemDate(alignedNow()).toString(),
  get: (target, key, receiver) =>
    key === "now"
      ? alignedNow
      : Reflect.get(target, key, receiver === AlignedDate ? target : receiver),
});

/** The database's clock minus this host's, from the quickest of a few reads. */
export async function measureDatabaseClockOffset(query) {
  let best = null;
  for (let sample = 0; sample < samples; sample += 1) {
    const sent = SystemDate.now();
    const result = await query(
      "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now",
    );
    const received = SystemDate.now();
    const database = Number(result.rows[0]?.now);
    if (!Number.isSafeInteger(database)) throw new Error("PILOT_CLOCK_UNAVAILABLE");
    if (best === null || received - sent < best.roundTrip)
      best = { roundTrip: received - sent, offset: database - received };
  }
  return best.offset;
}

export async function synchronizeProcessClock(query, report) {
  const measured = await measureDatabaseClockOffset(query);
  if (Math.abs(measured) > pilotClockMaximumOffsetMs) {
    if (!reportedTooLarge) report({ event: "INTERNAL_CLOCK_SKEW_TOO_LARGE", offsetMs: measured });
    reportedTooLarge = true;
    return;
  }
  reportedTooLarge = false;
  if (!reportedAligned) report({ event: "pilot_clock_aligned", offsetMs: measured });
  reportedAligned = true;
  offsetMs = measured;
}

/**
 * Follows the database's clock in this process from now on. A failed read keeps the last difference
 * (the database being away is reported by the readiness checks) and is read again next time.
 */
export async function alignProcessClockToDatabase(
  query,
  { report = (entry) => console.error(JSON.stringify(entry)) } = {},
) {
  if (timer !== null) return;
  globalThis.Date = AlignedDate;
  timer = setInterval(() => {
    synchronizeProcessClock(query, report).catch(() => undefined);
  }, syncIntervalMs);
  timer.unref();
  await synchronizeProcessClock(query, report).catch(() => undefined);
}

/**
 * WP-2423 M15: whether an instant is not after the database's now, read on the same transaction.
 * The application clock is only a lower bound of the database's, so an instant the database just
 * stamped can be a millisecond or two after `Date.now()`; comparing it with the application clock
 * refused live approvals at random. The database clock is the one time authority.
 */
export async function notAfterDatabaseNow(tx, at) {
  const result = await tx.query(
    "SELECT $1::timestamptz <= date_trunc('milliseconds', clock_timestamp()) AS ok",
    [at],
  );
  return result.rows[0]?.ok === true;
}

/** Tests only: back to this host's clock. */
export function resetProcessClockForTest() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  offsetMs = 0;
  latest = 0;
  reportedTooLarge = false;
  reportedAligned = false;
  globalThis.Date = SystemDate;
}
