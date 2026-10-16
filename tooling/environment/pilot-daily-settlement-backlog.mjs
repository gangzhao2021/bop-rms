import { createDailySettlementScheduler } from "./pilot-daily-settlement-scheduler.mjs";

/** Failed attempts in a row after which a day steps aside so later days still settle. */
export const DAILY_SETTLEMENT_DAY_ATTEMPTS_IN_PLACE = 3;
/** Retry delay for a day that stepped aside after `failures` attempts: 1 minute after stepping
 * aside, doubling, at most 30 minutes. */
export function dailySettlementDayRetryDelayMs(failures) {
  const aside = Math.max(failures - DAILY_SETTLEMENT_DAY_ATTEMPTS_IN_PLACE, 0);
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.min(aside, 10));
}
const dayOf = (window) =>
  Object.freeze({
    brandReference: window.brandReference,
    storeReference: window.storeReference,
    businessDate: window.businessDate,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
  });

/**
 * Bounded owner-window discovery, then oldest-first durable reconciliation.
 *
 * WP-2423 v15 isolation: days are discovered by their bounds (`readBounds`; the verified window
 * when not supplied), so one day whose window or settlement fails never hides the others. A
 * failing day is retried in place a few times (a passing dependency outage), then steps aside:
 * later days settle, and the day is retried on its own with growing delay until it settles.
 * While any day is unsettled an idle result carries `failure` (the day's own error) so the worker
 * reports it and the operations alert stays raised; `onDayFailure` records each failed attempt.
 */
export function createDailySettlementBacklog({
  coverage,
  readWindow,
  readBounds = readWindow,
  prepare,
  scope,
  now,
  readRun,
  execute,
  onDayFailure = () => undefined,
  createScheduler = createDailySettlementScheduler,
}) {
  let running = false,
    verified = false,
    completedThrough = null,
    scan = null,
    queue = [],
    current = null,
    inPlaceFailures = 0,
    discovered = 0;
  // Days that stepped aside, by day end: { day, scheduler, failures, failedAt, retryAt, error }.
  const deferred = new Map();
  const fail = () => {
    throw Error("DAILY_SETTLEMENT_BACKLOG_UNAVAILABLE");
  };
  const first = coverage.firstWindow;
  // One scheduler per day for the life of the process: a retry reuses its prepared run.
  const schedulerFor = (day) =>
    createScheduler({
      scope,
      now,
      readRun,
      execute,
      readWindow: () => readWindow({ endingAt: day.endsAt }),
      prepare: () => prepare({ endingAt: day.endsAt }),
    });
  const settle = async (scheduler) => {
    const result = await scheduler();
    if (!["Created", "Duplicate"].includes(result?.status) || result.checkCount !== 1)
      return fail();
    return result;
  };
  const record = (day, failures, error) => {
    try {
      onDayFailure({ businessDate: day.businessDate, failures, error });
    } catch {
      /* Reporting must never change settlement. */
    }
  };
  const outstanding = () => {
    let latest = null;
    for (const entry of deferred.values())
      if (latest === null || entry.failedAt > latest.failedAt) latest = entry;
    return latest?.error ?? null;
  };
  // Reported once nothing else is left to do, so catching up on other days is never slowed by
  // the worker's retry delay for a failed cycle.
  const withFailure = (result) => {
    const failure = result.status === "Idle" ? outstanding() : null;
    return failure === null ? result : Object.freeze({ ...result, failure });
  };
  return async () => {
    if (running) return fail();
    running = true;
    try {
      if (!verified) {
        const actual = await readWindow({ endingAt: first.endsAt });
        if (
          Object.keys(first).some((k) => actual[k] !== first[k]) ||
          actual.brandReference !== scope.brandReference ||
          actual.storeReference !== scope.storeReference
        )
          return fail();
        verified = true;
      }
      // A day that stepped aside is retried on its own once due (oldest due first).
      const at = Date.parse(now());
      const due = [...deferred.values()]
        .filter((entry) => entry.retryAt <= at)
        .sort((a, b) => (a.day.endsAt < b.day.endsAt ? -1 : 1))[0];
      if (due) {
        try {
          const result = await settle(due.scheduler);
          deferred.delete(due.day.endsAt);
          return withFailure(result);
        } catch (error) {
          due.failures += 1;
          due.error = error;
          due.failedAt = at;
          due.retryAt = at + dailySettlementDayRetryDelayMs(due.failures);
          record(due.day, due.failures, error);
        }
      }
      if (!scan && queue.length === 0) {
        const latest = await readBounds();
        if (latest.endsAt < first.endsAt) return fail();
        if (latest.endsAt === completedThrough)
          return withFailure({ status: "Idle", checkCount: 0 });
        if (completedThrough !== null && latest.endsAt < completedThrough) return fail();
        scan = dayOf(latest);
        discovered = 0;
      }
      if (scan) {
        const floor = completedThrough ?? first.startsAt;
        if (scan.startsAt < floor || scan.startsAt >= scan.endsAt || ++discovered > 3660)
          return fail();
        if (scan.startsAt === floor) {
          queue.unshift(scan);
          scan = null;
        } else {
          const previous = await readBounds({ endingAt: scan.startsAt });
          if (previous.endsAt !== scan.startsAt || previous.startsAt >= previous.endsAt)
            return fail();
          queue.unshift(scan);
          scan = dayOf(previous);
          return withFailure({ status: "Idle", checkCount: 0 });
        }
      }
      const day = queue[0];
      if (!day) return fail();
      current ??= schedulerFor(day);
      try {
        const result = await settle(current);
        inPlaceFailures = 0;
        completedThrough = day.endsAt;
        queue.shift();
        current = null;
        return withFailure(result);
      } catch (error) {
        inPlaceFailures += 1;
        record(day, inPlaceFailures, error);
        if (inPlaceFailures < DAILY_SETTLEMENT_DAY_ATTEMPTS_IN_PLACE) throw error;
        // Step aside: later days settle; this day keeps being retried on its own.
        deferred.set(day.endsAt, {
          day,
          scheduler: current,
          failures: inPlaceFailures,
          error,
          failedAt: at,
          retryAt: at + dailySettlementDayRetryDelayMs(inPlaceFailures),
        });
        inPlaceFailures = 0;
        completedThrough = day.endsAt;
        queue.shift();
        current = null;
        return withFailure({ status: "Idle", checkCount: 0 });
      }
    } finally {
      running = false;
    }
  };
}
