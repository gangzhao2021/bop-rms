import { createDailySettlementScheduler } from "./pilot-daily-settlement-scheduler.mjs";
/** Bounded owner-window discovery, then oldest-first durable reconciliation. */
export function createDailySettlementBacklog({
  coverage,
  readWindow,
  prepare,
  scope,
  now,
  readRun,
  execute,
  createScheduler = createDailySettlementScheduler,
}) {
  let running = false,
    verified = false,
    completedThrough = null,
    scan = null,
    queue = [],
    current = null,
    discovered = 0;
  const fail = () => {
    throw Error("DAILY_SETTLEMENT_BACKLOG_UNAVAILABLE");
  };
  const first = coverage.firstWindow;
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
      if (!scan && queue.length === 0) {
        const latest = await readWindow();
        if (latest.endsAt < first.endsAt) return fail();
        if (latest.endsAt === completedThrough) return { status: "Idle", checkCount: 0 };
        if (completedThrough !== null && latest.endsAt < completedThrough) return fail();
        scan = latest;
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
          const previous = await readWindow({ endingAt: scan.startsAt });
          if (previous.endsAt !== scan.startsAt || previous.startsAt >= previous.endsAt)
            return fail();
          queue.unshift(scan);
          scan = previous;
          return { status: "Idle", checkCount: 0 };
        }
      }
      const window = queue[0];
      if (!window) return fail();
      current ??= createScheduler({
        scope,
        now,
        readRun,
        execute,
        readWindow: () => readWindow({ endingAt: window.endsAt }),
        prepare: () => prepare({ endingAt: window.endsAt }),
      });
      const result = await current();
      if (!["Created", "Duplicate"].includes(result?.status) || result.checkCount !== 1)
        return fail();
      completedThrough = window.endsAt;
      queue.shift();
      current = null;
      return result;
    } finally {
      running = false;
    }
  };
}
