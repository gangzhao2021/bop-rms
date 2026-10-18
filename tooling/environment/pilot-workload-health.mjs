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
  return Object.freeze({
    lastCycleFailure,
    consecutiveFailures,
    failingForMs,
    // Alert-worthy: a person must look (the supervisor reports it; it never restarts for it).
    attention:
      snapshot.state === "attention_required" ||
      snapshot.state === "failed" ||
      (failingForMs !== null && failingForMs >= PILOT_WORKLOAD_PERSISTENT_FAILURE_MS),
    state: snapshot.state,
    cycleInFlight: snapshot.cycleInFlight,
    completedCycles: snapshot.completedCycles,
    lastCycleStartedAt: snapshot.lastCycleStartedAt,
    lastCycleCompletedAt: snapshot.lastCycleCompletedAt,
    reportAgeMs: now - observed,
    cycleAgeMs: snapshot.cycleInFlight ? now - started : null,
    lastCompletionAgeMs: completed === null ? null : now - completed,
  });
}
/** One line per failed cycle in the service log: category, safe code and SQLSTATE only. Returns
 * the failure instant now reported. */
function logPilotCycleFailure(component, snapshot, reported, time = new Date().toISOString()) {
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
      "business-contact-retention",
      "business-pickup-capacity-schedule",
      "business-batch-cancellation",
      "business-compensation",
      "business-inventory-release",
      "business-pickup-payment-expiry",
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
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
  const target = path.join(directory, component + ".health.json");
  let sequence = 0,
    reportedFailure = null;
  return (snapshot) => {
    const value = { ...identity, observedAt: new Date().toISOString(), snapshot };
    reportedFailure = logPilotCycleFailure(component, snapshot, reportedFailure, value.observedAt);
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
    return Object.freeze({ diningException: "dining-exception-worker.health.json" });
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
      contactRetention: "business-contact-retention.health.json",
      pickupCapacitySchedule: "business-pickup-capacity-schedule.health.json",
      ...(requireBatchCancellation === true
        ? { batchCancellation: "business-batch-cancellation.health.json" }
        : {}),
    });
  return fail();
}
