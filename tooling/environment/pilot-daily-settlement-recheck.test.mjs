import { expect, it, vi } from "vitest";
import {
  createDailySettlementRecheck,
  readDailySettlementChecks,
  withDailySettlementRecheck,
} from "./pilot-daily-settlement-recheck.mjs";
import {
  dailySettlementDayEnd,
  dailySettlementRunReference,
  dailySettlementRecheckRunReference,
} from "./pilot-daily-settlement-reference.mjs";
import { readPilotDailySettlementStatus } from "./pilot-daily-settlement-status.mjs";

const id = (n) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
const cad = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
// WP-2423 v15 shape: business day Oct 9; the Provider refunded $22.60 that day (the refund of a
// Sep 20 charge matching no Order) and our day-end totals did not count it.
const day = {
  businessDate: "2026-10-09",
  startsAt: "2026-10-09T10:00:00.000Z",
  endsAt: "2026-10-10T10:00:00.000Z",
};
const window = { ...scope, ...day };
const candidateReference = id(3);

function result(runReference, { checkedAt, internalRefunded, providerRefunded, check }) {
  const matched = internalRefunded === providerRefunded;
  return {
    run: {
      runReference,
      ...scope,
      actorReference: null,
      mode: "DailySettlement",
      purpose: "ReconcilePayments",
      scheduledAt: checkedAt,
      cutoffAt: checkedAt,
      maxCandidates: 1,
    },
    status: "Completed",
    completedAt: checkedAt,
    counts: {
      Matched: matched ? 1 : 0,
      Healed: 0,
      Unresolved: 0,
      Unavailable: 0,
      Difference: matched ? 0 : 1,
    },
    exceptions: matched
      ? []
      : [
          {
            exceptionReference: id(9),
            ...scope,
            candidateReference,
            reason: "RefundMismatch",
            severity: "Error",
            status: "Open",
            openedAt: "2026-10-10T10:05:00.000Z",
          },
        ],
    checks: [
      {
        checkReference: id(check),
        runReference,
        candidateReference,
        ...scope,
        mode: "DailySettlement",
        paymentIntentReference: null,
        settlementReference: "simset_20261009_" + String(check).repeat(64).slice(0, 64),
        outcome: matched ? "Matched" : "Difference",
        differenceReason: matched ? null : "RefundMismatch",
        internalStatus: null,
        providerStatus: null,
        internalCapturedAmount: cad(5650n),
        providerCapturedAmount: cad(5650n),
        internalRefundedAmount: cad(internalRefunded),
        providerRefundedAmount: cad(providerRefunded),
        exceptionReference: matched ? null : id(9),
        safeCode: null,
        checkedAt,
      },
    ],
  };
}

function fixture({ internalRefunded = 2260n } = {}) {
  const saved = new Map();
  const original = dailySettlementRunReference({ ...scope, ...day }).runReference;
  saved.set(
    original,
    result(original, {
      checkedAt: "2026-10-10T10:05:00.000Z",
      internalRefunded: 0n,
      providerRefunded: 2260n,
      check: 4,
    }),
  );
  const now = vi.fn(() => "2026-10-15T12:00:00.000Z");
  const ports = {
    coverage: { firstWindow: { ...window } },
    scope,
    now,
    readWindow: vi.fn(async () => ({ ...window })),
    readRun: vi.fn(async ({ runReference }) => saved.get(runReference) ?? null),
    prepare: vi.fn(async () => ({
      candidate: {
        ...scope,
        candidateReference,
        businessDate: day.businessDate,
        settlementReference: "simset_20261009_" + "b".repeat(64),
        internalCapturedAmount: cad(5650n),
        providerCapturedAmount: cad(5650n),
        internalRefundedAmount: cad(internalRefunded),
        providerRefundedAmount: cad(2260n),
        evidenceObservedAt: "2026-10-15T11:59:59.000Z",
      },
      sources: { window: { ...window } },
    })),
    execute: vi.fn(async (run, candidate) => {
      const value = result(run.runReference, {
        checkedAt: run.scheduledAt,
        internalRefunded: candidate.internalRefundedAmount.amountMinor,
        providerRefunded: candidate.providerRefundedAmount.amountMinor,
        check: 5,
      });
      saved.set(run.runReference, value);
      return { status: "Created", result: value };
    }),
  };
  return { ports, saved, original };
}

it("re-checks a differing day once its evidence changed and the re-check is the day's result", async () => {
  const f = fixture();
  const recheck = createDailySettlementRecheck(f.ports);
  expect(await recheck()).toEqual({
    status: "Created",
    checkCount: 1,
    businessDate: "2026-10-09",
    outcome: "Matched",
  });
  const [run] = f.ports.execute.mock.calls[0];
  expect(run).toMatchObject({
    runReference: dailySettlementRecheckRunReference({ ...scope, ...day }, 1),
    mode: "DailySettlement",
    actorReference: null,
    maxCandidates: 1,
  });
  // The day's own run stays as recorded (append-only); the re-check is the current result.
  const checks = await readDailySettlementChecks({ readRun: f.ports.readRun, scope, window: day });
  expect(checks.original.checks[0].outcome).toBe("Difference");
  expect(checks.latest.checks[0].outcome).toBe("Matched");
  expect(checks.rechecks).toHaveLength(1);
  // Nothing new afterwards: the day now matches and is not checked again.
  expect(await recheck()).toEqual({ status: "Idle", checkCount: 0 });
  expect(f.ports.execute).toHaveBeenCalledTimes(1);
  const status = await readPilotDailySettlementStatus({ ...f.ports, limit: 1 });
  expect(status.days[0]).toMatchObject({ outcome: "Matched", rechecks: 1 });
  expect(status.reviewDays).toBe(0);
});

it("leaves a lasting difference alone while its evidence is unchanged", async () => {
  const f = fixture({ internalRefunded: 0n });
  const recheck = createDailySettlementRecheck(f.ports);
  expect(await recheck()).toEqual({ status: "Idle", checkCount: 0 });
  expect(f.ports.prepare).toHaveBeenCalledTimes(1);
  expect(f.ports.execute).not.toHaveBeenCalled();
  const status = await readPilotDailySettlementStatus({ ...f.ports, limit: 1 });
  expect(status.days[0]).toMatchObject({ outcome: "Difference", rechecks: 0 });
  expect(status.reviewDays).toBe(1);
});

it("skips days not settled yet and refuses evidence for another day", async () => {
  const f = fixture();
  f.saved.clear();
  expect(await createDailySettlementRecheck(f.ports)()).toEqual({ status: "Idle", checkCount: 0 });
  expect(f.ports.prepare).not.toHaveBeenCalled();
  const g = fixture();
  g.ports.prepare.mockResolvedValue({
    candidate: { ...(await fixture().ports.prepare()).candidate, candidateReference: id(77) },
    sources: { window: { ...window } },
  });
  await expect(createDailySettlementRecheck(g.ports)()).rejects.toThrow(
    "DAILY_SETTLEMENT_RECHECK_UNAVAILABLE",
  );
});

it("the worker re-checks only when day-end settlement is idle, at most once per interval", async () => {
  let at = Date.parse("2026-10-15T12:00:00.000Z");
  const backlog = vi.fn(async () => ({ status: "Idle", checkCount: 0 }));
  const recheck = vi.fn(async () => ({ status: "Idle", checkCount: 0 }));
  const runOnce = withDailySettlementRecheck({
    backlog,
    recheck,
    now: () => new Date(at).toISOString(),
    intervalMs: 60_000,
  });
  await runOnce();
  await runOnce();
  expect(recheck).toHaveBeenCalledTimes(1);
  at += 60_000;
  recheck.mockRejectedValueOnce(Error("DAILY_SETTLEMENT_SOURCE_UNAVAILABLE"));
  // A failed re-check never stops day-end settlement.
  expect(await runOnce()).toEqual({ status: "Idle", checkCount: 0 });
  backlog.mockResolvedValueOnce({ status: "Created", checkCount: 1 });
  at += 60_000;
  expect(await runOnce()).toEqual({ status: "Created", checkCount: 1 });
  expect(recheck).toHaveBeenCalledTimes(2);
});

it("WP-2423: a scheduled run and its re-checks name the day's end; other references are only hints", () => {
  const named = { ...scope, ...day };
  expect(dailySettlementDayEnd(dailySettlementRunReference(named).runReference)).toBe(day.endsAt);
  expect(dailySettlementDayEnd(dailySettlementRecheckRunReference(named, 3))).toBe(day.endsAt);
  expect(dailySettlementDayEnd("not a reference")).toBeNull();
  expect(dailySettlementDayEnd(null)).toBeNull();
});
