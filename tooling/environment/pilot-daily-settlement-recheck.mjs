import {
  parsePaymentReference,
  parsePaymentInstant,
  parsePaymentReconciliationRunResult,
  parseSettlementReconciliationCandidate,
} from "../../packages/rms/payment/src/index.ts";
import {
  dailySettlementRunReference,
  dailySettlementRecheckRunReference,
  dailySettlementRecheckLimit,
} from "./pilot-daily-settlement-reference.mjs";

const fail = () => {
  throw Error("DAILY_SETTLEMENT_RECHECK_UNAVAILABLE");
};
const amounts = (value) => [
  value.internalCapturedAmount.amountMinor,
  value.providerCapturedAmount?.amountMinor ?? null,
  value.internalRefundedAmount.amountMinor,
  value.providerRefundedAmount?.amountMinor ?? null,
];
const sameAmounts = (a, b) => amounts(a).every((value, i) => value === amounts(b)[i]);

/**
 * WP-2423: one closed business day's settlement checks — the day's own run and its later
 * re-checks (in order). The latest check is the day's current result. Null before the day's own
 * run exists. Every run must be a single-check settlement run of the same day (same candidate).
 */
export async function readDailySettlementChecks({ readRun, scope, window }) {
  const brandReference = String(parsePaymentReference(scope.brandReference)),
    storeReference = String(parsePaymentReference(scope.storeReference)),
    day = { brandReference, storeReference, ...window };
  const validate = (value, runReference, candidateReference) => {
    const result = parsePaymentReconciliationRunResult(value),
      run = result.run,
      check = result.checks[0];
    if (
      run.runReference !== runReference ||
      run.brandReference !== brandReference ||
      run.storeReference !== storeReference ||
      run.mode !== "DailySettlement" ||
      run.actorReference !== null ||
      run.maxCandidates !== 1 ||
      run.scheduledAt < window.endsAt ||
      result.checks.length !== 1 ||
      (candidateReference !== null && check.candidateReference !== candidateReference) ||
      !check.settlementReference?.startsWith(
        "simset_" + window.businessDate.replaceAll("-", "") + "_",
      )
    )
      return fail();
    return result;
  };
  const { runReference } = dailySettlementRunReference(day);
  const original = await readRun({ runReference });
  if (original === null) return null;
  const first = validate(original, runReference, null);
  const candidate = first.checks[0].candidateReference;
  const rechecks = [];
  for (let n = 1; n <= dailySettlementRecheckLimit; n++) {
    const reference = dailySettlementRecheckRunReference(day, n);
    const value = await readRun({ runReference: reference });
    if (value === null) break;
    const result = validate(value, reference, candidate);
    if (result.checks[0].checkedAt < (rechecks.at(-1) ?? first).checks[0].checkedAt) return fail();
    rechecks.push(result);
  }
  return Object.freeze({
    original: first,
    rechecks: Object.freeze(rechecks),
    latest: rechecks.at(-1) ?? first,
  });
}

/**
 * WP-2423: re-checks closed business days whose latest settlement check did not match, when the
 * evidence for the day has changed since (for example staff refunded a charge the Provider took
 * that matched no Order, or a late Provider record arrived). A matching re-check resolves the
 * day's earlier difference in the Payment owner (append-only, audited). Nothing changes when the
 * evidence is the same, so a lasting difference stays open for staff without growing history.
 * One re-check per call, newest day first, at most `maxDays` closed days back within coverage.
 */
export function createDailySettlementRecheck({
  coverage,
  scope,
  now,
  readWindow,
  prepare,
  readRun,
  execute,
  maxDays = 31,
}) {
  const brandReference = String(parsePaymentReference(scope.brandReference)),
    storeReference = String(parsePaymentReference(scope.storeReference)),
    first = coverage.firstWindow;
  let running = false;
  return async () => {
    if (running) return fail();
    running = true;
    try {
      let window = await readWindow();
      for (let n = 0; n < maxDays; n++) {
        if (
          window.brandReference !== brandReference ||
          window.storeReference !== storeReference ||
          window.startsAt < first.startsAt ||
          window.endsAt > parsePaymentInstant(now())
        )
          return fail();
        const day = {
          businessDate: window.businessDate,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        };
        const checks = await readDailySettlementChecks({ readRun, scope, window: day });
        const latest = checks?.latest.checks[0];
        if (
          checks !== null &&
          latest.outcome !== "Matched" &&
          checks.rechecks.length < dailySettlementRecheckLimit
        ) {
          const prepared = await prepare({ endingAt: window.endsAt });
          const candidate = parseSettlementReconciliationCandidate(prepared.candidate);
          if (
            candidate.brandReference !== brandReference ||
            candidate.storeReference !== storeReference ||
            candidate.businessDate !== window.businessDate ||
            candidate.candidateReference !== latest.candidateReference ||
            prepared.sources.window.startsAt !== window.startsAt ||
            prepared.sources.window.endsAt !== window.endsAt
          )
            return fail();
          if (!sameAmounts(candidate, latest)) {
            const scheduledAt = parsePaymentInstant(now());
            if (candidate.evidenceObservedAt > scheduledAt) return fail();
            const runReference = dailySettlementRecheckRunReference(
              { brandReference, storeReference, ...day },
              checks.rechecks.length + 1,
            );
            const run = {
              runReference,
              brandReference,
              storeReference,
              actorReference: null,
              mode: "DailySettlement",
              purpose: "ReconcilePayments",
              scheduledAt,
              cutoffAt: scheduledAt,
              maxCandidates: 1,
            };
            const outcome = await execute(run, candidate);
            if (!["Created", "Duplicate"].includes(outcome?.status)) return fail();
            const result = parsePaymentReconciliationRunResult(outcome.result);
            if (
              result.run.runReference !== runReference ||
              result.checks.length !== 1 ||
              result.checks[0].candidateReference !== candidate.candidateReference
            )
              return fail();
            return {
              status: outcome.status,
              checkCount: 1,
              businessDate: window.businessDate,
              outcome: result.checks[0].outcome,
            };
          }
        }
        if (window.startsAt === first.startsAt) break;
        const previous = await readWindow({ endingAt: window.startsAt });
        if (previous.endsAt !== window.startsAt || previous.startsAt >= previous.endsAt)
          return fail();
        window = previous;
      }
      return { status: "Idle", checkCount: 0 };
    } finally {
      running = false;
    }
  };
}

/** How often closed days that did not match are looked at again once the backlog is idle. */
export const DAILY_SETTLEMENT_RECHECK_INTERVAL_MS = 15 * 60_000;
/**
 * WP-2423: the daily settlement worker first settles every closed day; when idle it re-checks a
 * day that did not match, at most once per interval (the first time right after start). A failed
 * re-check is tried again next interval and never stops day-end settlement: the day stays listed
 * as a difference for staff and the operations alert until a re-check matches.
 */
export function withDailySettlementRecheck({
  backlog,
  recheck,
  now,
  intervalMs = DAILY_SETTLEMENT_RECHECK_INTERVAL_MS,
}) {
  let last = null;
  return async () => {
    const progress = await backlog();
    if (progress?.status !== "Idle") return progress;
    const at = Date.parse(now());
    if (last !== null && at - last < intervalMs) return progress;
    last = at;
    try {
      const result = await recheck();
      // Another re-check may be due right away (several days changed): look again next poll.
      if (result.status !== "Idle") last = null;
      return { status: result.status, checkCount: result.checkCount };
    } catch {
      return progress;
    }
  };
}
