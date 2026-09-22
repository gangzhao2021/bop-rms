import { createDailySettlementScheduler } from "./pilot-daily-settlement-scheduler.mjs";
/** Read existing daily results only. Missing days never trigger reconciliation. */
export async function readPilotDailySettlementStatus({
  coverage,
  scope,
  now,
  readWindow,
  readRun,
  limit = 31,
}) {
  const fail = () => {
    throw Error("DAILY_SETTLEMENT_STATUS_UNAVAILABLE");
  };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 31) return fail();
  const first = coverage.firstWindow;
  const verified = await readWindow({ endingAt: first.endsAt });
  if (Object.keys(first).some((k) => verified[k] !== first[k])) return fail();
  let window = await readWindow();
  const days = [];
  let coverageScanComplete = false;
  for (let n = 0; n < limit; n++) {
    if (window.startsAt < first.startsAt) return fail();
    let result;
    const missing = new Error("MISSING");
    const schedule = createDailySettlementScheduler({
      scope,
      now,
      readWindow: async () => window,
      readRun: async (query) => (result = await readRun(query)),
      prepare: async () => {
        throw missing;
      },
      execute: async () => fail(),
    });
    try {
      await schedule();
    } catch (error) {
      if (error !== missing) throw error;
    }
    const check = result?.checks[0];
    days.push(
      Object.freeze({
        businessDate: window.businessDate,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        state: result ? "Recorded" : "Missing",
        outcome: check?.outcome ?? null,
        checkedAt: check?.checkedAt ?? null,
      }),
    );
    if (window.startsAt === first.startsAt) {
      coverageScanComplete = true;
      break;
    }
    const previous = await readWindow({ endingAt: window.startsAt });
    if (previous.endsAt !== window.startsAt || previous.startsAt >= previous.endsAt) return fail();
    window = previous;
  }
  return Object.freeze({
    scope: "InternalTestClosedDays",
    firstCoveredBusinessDate: first.businessDate,
    coverageScanComplete,
    missingDays: days.filter((x) => x.state === "Missing").length,
    reviewDays: days.filter((x) => x.state === "Recorded" && x.outcome !== "Matched").length,
    days: Object.freeze(days),
  });
}
