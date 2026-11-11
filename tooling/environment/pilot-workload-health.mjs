import fs from "node:fs";
import path from "node:path";
import process from "node:process";
const fail = () => {
  throw new Error("PILOT_WORKLOAD_HEALTH_UNAVAILABLE");
};
const exact = (value, keys) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
  return value;
};
const instant = (value) => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return Date.parse(value);
};
const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,79}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
/** WP-2423 pilot resilience: transient failures that persist this long are alert-worthy. */
export const PILOT_WORKLOAD_PERSISTENT_FAILURE_MS = 120_000;
/**
 * DEC-WORKER-HEALTH-TRUTH: a workload publishes at every cycle's start and end; the longest poll is
 * 60 s and a workload needing a person retries every 5 minutes. A report older than this is no
 * heartbeat: the workload has stopped or hangs, and a person must look.
 */
export const PILOT_WORKLOAD_HEALTH_STALE_MS = 10 * 60_000;
export function parsePilotWorkloadHealth(value, identity, now = Date.now()) {
  const record = exact(value, ["pid", "started", "observedAt", "snapshot"]);
  if (
    record.pid !== identity.pid ||
    record.started !== identity.started ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.started !== "string" ||
    !/^\d+$/u.test(record.started)
  )
    return fail();
  const observed = instant(record.observedAt);
  if (!Number.isFinite(now) || observed > now) return fail();
  const snapshot = exact(record.snapshot, [
    "state",
    "cycleInFlight",
    "completedCycles",
    "lastCycleStartedAt",
    "lastCycleCompletedAt",
    ...(Object.hasOwn(record.snapshot ?? {}, "lastCycleFailure") ? ["lastCycleFailure"] : []),
    ...(Object.hasOwn(record.snapshot ?? {}, "consecutiveFailures")
      ? ["consecutiveFailures", "failingSince"]
      : []),
  ]);
  if (
    !["idle", "running", "attention_required", "stopping", "stopped", "failed"].includes(
      snapshot.state,
    ) ||
    typeof snapshot.cycleInFlight !== "boolean" ||
    !Number.isSafeInteger(snapshot.completedCycles) ||
    snapshot.completedCycles < 0
  )
    return fail();
  const started =
    snapshot.lastCycleStartedAt === null ? null : instant(snapshot.lastCycleStartedAt);
  const completed =
    snapshot.lastCycleCompletedAt === null ? null : instant(snapshot.lastCycleCompletedAt);
  if (
    (started !== null && started > observed) ||
    (completed !== null && completed > observed) ||
    (snapshot.cycleInFlight && started === null) ||
    (snapshot.completedCycles === 0) !== (completed === null) ||
    (completed !== null && started === null)
  )
    return fail();
  const consecutiveFailures = snapshot.consecutiveFailures ?? 0;
  const failingSince =
    snapshot.failingSince === undefined || snapshot.failingSince === null
      ? null
      : instant(snapshot.failingSince);
  if (
    !Number.isSafeInteger(consecutiveFailures) ||
    consecutiveFailures < 0 ||
    (failingSince === null) !== (consecutiveFailures === 0) ||
    (failingSince !== null && failingSince > observed)
  )
    return fail();
  let lastCycleFailure = null;
  if (snapshot.lastCycleFailure !== undefined && snapshot.lastCycleFailure !== null) {
    const detailed = Object.hasOwn(snapshot.lastCycleFailure, "sqlState");
    const failure = exact(snapshot.lastCycleFailure, [
      "occurredAt",
      "category",
      ...(detailed ? ["code", "sqlState"] : []),
    ]);
    const failedAt = instant(failure.occurredAt);
    if (
      (detailed &&
        ((failure.code !== null && !SAFE_FAILURE_CODE.test(failure.code)) ||
          (failure.sqlState !== null && !SQLSTATE.test(failure.sqlState)))) ||
      started === null ||
      failedAt > observed ||
      ![
        "SerializationConflict",
        "Deadlock",
        "LockUnavailable",
        "QueryCancelled",
        "DependencyUnavailable",
        "Unclassified",
      ].includes(failure.category)
    )
      return fail();
    lastCycleFailure = Object.freeze({
      occurredAt: failure.occurredAt,
      category: failure.category,
      ...(detailed ? { code: failure.code, sqlState: failure.sqlState } : {}),
    });
  }
  const failingForMs = failingSince === null ? null : now - failingSince;
  const reportAgeMs = now - observed;
  return Object.freeze({
    lastCycleFailure,
    consecutiveFailures,
    failingForMs,
    // Alert-worthy: a person must look (the supervisor reports it; it never restarts for it).
    attention:
      snapshot.state === "attention_required" ||
      snapshot.state === "failed" ||
      reportAgeMs >= PILOT_WORKLOAD_HEALTH_STALE_MS ||
      (failingForMs !== null && failingForMs >= PILOT_WORKLOAD_PERSISTENT_FAILURE_MS),
    state: snapshot.state,
    cycleInFlight: snapshot.cycleInFlight,
    completedCycles: snapshot.completedCycles,
    lastCycleStartedAt: snapshot.lastCycleStartedAt,
    lastCycleCompletedAt: snapshot.lastCycleCompletedAt,
    reportAgeMs,
    cycleAgeMs: snapshot.cycleInFlight ? now - started : null,
    lastCompletionAgeMs: completed === null ? null : now - completed,
  });
}
/** One line per failed cycle in the service log: category, safe code and SQLSTATE only. Returns
 * the failure instant now reported. */
function logPilotCycleFailure(
  component,
  snapshot,
  reported,
  time = new Date().toISOString(),
  store = null,
) {
  const failure = snapshot?.lastCycleFailure;
  if (!failure || failure.occurredAt === reported) return reported;
  try {
    process.stderr.write(
      JSON.stringify({
        level: 50,
        time,
        module: "pilot-workload-health",
        event: "workload_cycle_failed",
        component,
        // Which Store's workload, in the process shared by the Stores after the first.
        ...(store === null ? {} : { store }),
        state: snapshot.state,
        consecutiveFailures: Number.isSafeInteger(snapshot.consecutiveFailures)
          ? snapshot.consecutiveFailures
          : null,
        category: failure.category,
        code: SAFE_FAILURE_CODE.test(failure.code ?? "") ? failure.code : null,
        sqlState: SQLSTATE.test(failure.sqlState ?? "") ? failure.sqlState : null,
      }) + "\n",
    );
  } catch {
    /* Diagnostics must not change workload execution. */
  }
  return failure.occurredAt;
}
/** Failure log only, for a supervised workload without its own health file (cart expiry): its
 * retried failures still reach the service log instead of disappearing. */
export function createPilotWorkloadFailureLogger(component) {
  if (!/^business-[a-z-]{3,40}$/u.test(component)) return fail();
  let reported = null;
  return (snapshot) => {
    reported = logPilotCycleFailure(component, snapshot, reported);
  };
}
export function createPilotWorkloadHealthObserver(directory, component) {
  if (
    ![
      "kitchen-queue-worker",
      "business-events",
      "business-payment-wait",
      "business-dining-checkout-expiry",
      "business-table-online-refund",
      "business-guest-table-close",
      "business-ordinary-refund-follow-through",
      "business-contact-retention",
      "business-webhook-evidence-retention",
      "business-pickup-capacity-schedule",
      "business-batch-cancellation",
      "business-compensation",
      "business-inventory-release",
      "business-pickup-payment-expiry",
      "business-ordinary-refund-follow-through",
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
      "dining-exception-member-points",
    ].includes(component)
  )
    return fail();
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    fs.realpathSync(directory) !== directory
  )
    return fail();
  const fields = fs.readFileSync("/proc/self/stat", "utf8").split(") ").at(-1).trim().split(/\s+/u);
  const identity = { pid: process.pid, started: fields[19] };
  const store = /(?:^|\/)(stores\/[^/]+)$/u.exec(directory)?.[1] ?? null;
  const target = path.join(directory, component + ".health.json");
  let sequence = 0,
    reportedFailure = null;
  return (snapshot) => {
    const value = { ...identity, observedAt: new Date().toISOString(), snapshot };
    reportedFailure = logPilotCycleFailure(
      component,
      snapshot,
      reportedFailure,
      value.observedAt,
      store,
    );
    const temporary = target + "." + process.pid + "." + ++sequence + ".tmp";
    let created = false;
    try {
      parsePilotWorkloadHealth(value, identity);
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      created = true;
      fs.renameSync(temporary, target);
      created = false;
    } catch {
      process.stderr.write("PILOT_HEALTH_WRITE_UNAVAILABLE\n");
    } finally {
      if (created) fs.unlinkSync(temporary);
    }
  };
}

export function createPilotKitchenHealthObserver(directory) {
  return createPilotWorkloadHealthObserver(directory, "kitchen-queue-worker");
}
export function pilotHealthComponents(
  service,
  { requireBatchCancellation = false, requireCompensation = false } = {},
) {
  if (service === "dining-exception-worker")
    return Object.freeze({
      diningException: "dining-exception-worker.health.json",
      // v15 2026-11-06 (points-sweep): the member points sweep, its own supervised workload.
      memberPoints: "dining-exception-member-points.health.json",
    });
  if (service === "daily-settlement-worker")
    return Object.freeze({ dailySettlement: "daily-settlement-worker.health.json" });
  if (service === "reconciliation-worker")
    return Object.freeze({ reconciliation: "reconciliation-worker.health.json" });
  if (service === "kitchen-queue-worker")
    return Object.freeze({ kitchen: "kitchen-queue-worker.health.json" });
  if (service === "business-worker")
    return Object.freeze({
      ...(requireCompensation === true
        ? { compensation: "business-compensation.health.json" }
        : {}),
      events: "business-events.health.json",
      paymentWait: "business-payment-wait.health.json",
      inventoryRelease: "business-inventory-release.health.json",
      pickupPaymentExpiry: "business-pickup-payment-expiry.health.json",
      diningCheckoutExpiry: "business-dining-checkout-expiry.health.json",
      tableOnlineRefund: "business-table-online-refund.health.json",
      guestTableClose: "business-guest-table-close.health.json",
      ordinaryRefundFollowThrough: "business-ordinary-refund-follow-through.health.json",
      contactRetention: "business-contact-retention.health.json",
      webhookEvidenceRetention: "business-webhook-evidence-retention.health.json",
      pickupCapacitySchedule: "business-pickup-capacity-schedule.health.json",
      ...(requireBatchCancellation === true
        ? { batchCancellation: "business-batch-cancellation.health.json" }
        : {}),
    });
  return fail();
}

/** Parts of a business worker that run only where the Store's settings turn them on. */
const SETTINGS_DEPENDENT = new Set(["batchCancellation", "compensation"]);
const startedOf = (stat) =>
  stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u)[19];
/**
 * DEC-MULTI-MERCHANT-ONE-INSTALLATION A5: one Store's workers in the shared `store-workers` process,
 * from that Store's own health files, once the process says the worker has started
 * (`readHostedStoreLiveness`). DEC-WORKER-HEALTH-TRUTH (v15 bc7e2965): every part must have a
 * current report of this process; one that is missing, left by an earlier process, unreadable or
 * without a heartbeat is named in `attention`, never read as running. Only the parts the Store's
 * settings turn on may be absent. Reported, never used to stop or replace the process.
 */
export async function readHostedStoreHealth(directory, service, pid, read = readFileText) {
  const files = Object.entries(
    pilotHealthComponents(service, { requireBatchCancellation: true, requireCompensation: true }),
  );
  let started;
  try {
    started = startedOf(await read(`/proc/${pid}/stat`));
  } catch {
    return { attention: files.map(([component]) => component).sort() };
  }
  const attention = [];
  for (const [component, file] of files) {
    try {
      const health = parsePilotWorkloadHealth(JSON.parse(await read(path.join(directory, file))), {
        pid,
        started,
      });
      if (health.attention === true) attention.push(component);
    } catch (error) {
      if (error?.code === "ENOENT" && SETTINGS_DEPENDENT.has(component)) continue;
      attention.push(component);
    }
  }
  return attention.length === 0 ? {} : { attention: attention.sort() };
}

/** DEC-WORKER-HEALTH-TRUTH: the Store workers the shared process runs, as it reports them. */
export const HOSTED_WORKER_SERVICES = Object.freeze([
  "business-worker",
  "kitchen-queue-worker",
  "reconciliation-worker",
  "daily-settlement-worker",
  "dining-exception-worker",
]);
export const HOSTED_LIVENESS_FILE = "store-workers.liveness.json";
/** The shared process rewrites each Store's file at least this often. */
export const HOSTED_LIVENESS_HEARTBEAT_MS = 30_000;
/** Four heartbeats missed: the process is no longer saying anything about this Store. */
export const HOSTED_LIVENESS_STALE_MS = 2 * 60_000;
const LIVENESS_STATES = Object.freeze(["starting", "running", "down"]);
/**
 * DEC-WORKER-HEALTH-TRUTH: which of a Store's workers the shared process has really started:
 * `starting` (not started yet), `running` (its start succeeded and it has not ended) or `down` (its
 * start failed, it produced no workload, or it ended; retried every 30 s). Only from the process
 * named by the supervisor, and only with a heartbeat of the last two minutes.
 */
export function parseHostedLiveness(value, identity, now = Date.now()) {
  const record = exact(value, ["pid", "started", "observedAt", "services"]);
  if (record.pid !== identity.pid || record.started !== identity.started) return fail();
  const observed = instant(record.observedAt);
  if (!Number.isFinite(now) || observed > now || now - observed >= HOSTED_LIVENESS_STALE_MS)
    return fail();
  const services = record.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) return fail();
  const result = {};
  for (const [service, entry] of Object.entries(services)) {
    if (!HOSTED_WORKER_SERVICES.includes(service)) return fail();
    const { state, since } = exact(entry, ["state", "since"]);
    const sinceMs = instant(since);
    if (!LIVENESS_STATES.includes(state) || sinceMs > observed) return fail();
    result[service] = Object.freeze({ state, sinceMs });
  }
  return Object.freeze(result);
}
/** Null while the process has written nothing for this Store; "unavailable" when it can't be trusted. */
export async function readHostedStoreLiveness(
  directory,
  pid,
  read = readFileText,
  now = Date.now(),
) {
  let text;
  try {
    text = await read(path.join(directory, HOSTED_LIVENESS_FILE));
  } catch (error) {
    return error?.code === "ENOENT" ? null : "unavailable";
  }
  try {
    return parseHostedLiveness(
      JSON.parse(text),
      { pid, started: startedOf(await read(`/proc/${pid}/stat`)) },
      now,
    );
  } catch {
    return "unavailable";
  }
}
const selfIdentity = () => ({
  pid: process.pid,
  started: startedOf(fs.readFileSync("/proc/self/stat", "utf8")),
});
/**
 * The shared process's writer for one Store's liveness file: private (0600, the Store's own 0700
 * directory), replaced atomically. Never throws; a failed write is reported once per directory and
 * the supervisor then reads the Store's workers as not confirmed.
 */
export function createHostedLivenessWriter(
  directory,
  { identity = selfIdentity, report = (line) => process.stderr.write(line), now = Date.now } = {},
) {
  const target = path.join(directory, HOSTED_LIVENESS_FILE);
  let sequence = 0,
    reported = false,
    self = null;
  return (services) => {
    let temporary = null;
    try {
      const stat = fs.lstatSync(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid() ||
        (stat.mode & 0o077) !== 0 ||
        fs.realpathSync(directory) !== directory
      )
        return fail();
      self ??= identity();
      const value = { ...self, observedAt: new Date(now()).toISOString(), services };
      parseHostedLiveness(value, self, Date.parse(value.observedAt));
      temporary = target + "." + process.pid + "." + ++sequence + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
      temporary = null;
      reported = false;
    } catch {
      if (!reported) report("PILOT_HOSTED_LIVENESS_WRITE_UNAVAILABLE\n");
      reported = true;
    } finally {
      if (temporary !== null) fs.rmSync(temporary, { force: true });
    }
  };
}
const readFileText = (file) => fs.promises.readFile(file, "utf8");
