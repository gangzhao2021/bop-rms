import { createHash } from "node:crypto";
import {
  parsePaymentReference,
  parsePaymentInstant,
  parsePaymentReconciliationRunResult,
  parseSettlementReconciliationCandidate,
} from "../../packages/rms/payment/src/index.ts";
/** Reconciles the latest closed owner-defined day; historical backfill is separate. */
export function createDailySettlementScheduler({
  scope,
  now,
  readWindow,
  prepare,
  readRun,
  execute,
}) {
  const brandReference = String(parsePaymentReference(scope.brandReference)),
    storeReference = String(parsePaymentReference(scope.storeReference));
  let running = false,
    completed = null,
    pending = null;
  const fail = () => {
    throw Error("DAILY_SETTLEMENT_SCHEDULE_UNAVAILABLE");
  };
  return async () => {
    if (running) return fail();
    running = true;
    try {
      const window = pending?.window ?? (await readWindow()),
        at = parsePaymentInstant(now());
      if (
        window.brandReference !== brandReference ||
        window.storeReference !== storeReference ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(window.businessDate) ||
        parsePaymentInstant(window.startsAt) >= parsePaymentInstant(window.endsAt) ||
        window.endsAt > at
      )
        return fail();
      const key = JSON.stringify([
        brandReference,
        storeReference,
        window.businessDate,
        window.startsAt,
        window.endsAt,
      ]);
      const stamp = Date.parse(window.endsAt).toString(16).padStart(12, "0"),
        h = createHash("sha256")
          .update("BOP_INTERNAL_DAILY_SCHEDULE_V1:" + key)
          .digest("hex");
      const runReference = String(
        parsePaymentReference(
          stamp.slice(0, 8) +
            "-" +
            stamp.slice(8) +
            "-7" +
            h.slice(0, 3) +
            "-" +
            (8 + (parseInt(h[3], 16) & 3)).toString(16) +
            h.slice(4, 7) +
            "-" +
            h.slice(7, 19),
        ),
      );
      if (completed === key) return { status: "Idle", checkCount: 0 };
      const validate = (value) => {
        const result = parsePaymentReconciliationRunResult(value),
          run = result.run,
          check = result.checks[0];
        if (
          run.runReference !== runReference ||
          run.brandReference !== brandReference ||
          run.storeReference !== storeReference ||
          run.actorReference !== null ||
          run.mode !== "DailySettlement" ||
          run.purpose !== "ReconcilePayments" ||
          run.maxCandidates !== 1 ||
          run.scheduledAt < window.endsAt ||
          run.scheduledAt !== run.cutoffAt ||
          run.cutoffAt > parsePaymentInstant(now()) ||
          result.checks.length !== 1 ||
          !check.settlementReference?.startsWith(
            "simset_" + window.businessDate.replaceAll("-", "") + "_",
          )
        )
          return fail();
        return result;
      };
      const existing = await readRun({ runReference });
      if (existing !== null) {
        validate(existing);
        completed = key;
        pending = null;
        return { status: "Duplicate", checkCount: 1 };
      }
      if (pending && pending.key !== key) return fail();
      if (!pending) {
        const prepared = await prepare(),
          candidate = parseSettlementReconciliationCandidate(prepared.candidate),
          actual = prepared.sources.window;
        if (
          JSON.stringify([
            candidate.brandReference,
            candidate.storeReference,
            candidate.businessDate,
            actual.startsAt,
            actual.endsAt,
          ]) !== key
        )
          return fail();
        const scheduledAt = parsePaymentInstant(now());
        if (candidate.evidenceObservedAt > scheduledAt) return fail();
        pending = {
          window,
          key,
          candidate,
          run: {
            runReference,
            brandReference,
            storeReference,
            actorReference: null,
            mode: "DailySettlement",
            purpose: "ReconcilePayments",
            scheduledAt,
            cutoffAt: scheduledAt,
            maxCandidates: 1,
          },
        };
      }
      const outcome = await execute(pending.run, pending.candidate);
      if (!["Created", "Duplicate"].includes(outcome.status)) return fail();
      const result = validate(outcome.result);
      if (
        Object.keys(pending.run).some((k) => result.run[k] !== pending.run[k]) ||
        result.checks[0].candidateReference !== pending.candidate.candidateReference ||
        result.checks[0].settlementReference !== pending.candidate.settlementReference
      )
        return fail();
      completed = key;
      pending = null;
      return { status: outcome.status, checkCount: 1 };
    } finally {
      running = false;
    }
  };
}
