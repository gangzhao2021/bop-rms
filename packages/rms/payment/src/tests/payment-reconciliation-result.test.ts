import { expect, it } from "vitest";
import {
  parsePaymentReconciliationRunResult,
  equivalentPaymentReconciliationResult,
} from "../application/payment-reconciliation.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const money = (amountMinor: bigint) => ({ currencyCode: "CAD", amountMinor });
function fixture() {
  const run = {
    runReference: id(1),
    mode: "Operational",
    brandReference: id(2),
    storeReference: id(3),
    actorReference: null,
    purpose: "ReconcilePayments",
    scheduledAt: "2026-09-22T00:00:00.000Z",
    cutoffAt: "2026-09-21T23:59:00.000Z",
    maxCandidates: 10,
  };
  const check = {
    checkReference: id(4),
    runReference: id(1),
    candidateReference: id(5),
    mode: "Operational",
    brandReference: id(2),
    storeReference: id(3),
    paymentIntentReference: id(6),
    settlementReference: null,
    outcome: "Difference",
    differenceReason: "RefundMismatch",
    internalStatus: "Captured",
    providerStatus: "Captured",
    internalCapturedAmount: money(1130n),
    providerCapturedAmount: money(1130n),
    internalRefundedAmount: money(0n),
    providerRefundedAmount: money(1130n),
    exceptionReference: id(7),
    safeCode: null,
    checkedAt: "2026-09-22T00:01:00.000Z",
  };
  const exception = {
    exceptionReference: id(7),
    brandReference: id(2),
    storeReference: id(3),
    candidateReference: id(5),
    reason: "RefundMismatch",
    severity: "Error",
    status: "Open",
    openedAt: check.checkedAt,
  };
  return {
    run,
    status: "Completed",
    completedAt: check.checkedAt,
    checks: [check],
    exceptions: [exception],
    counts: { Matched: 0, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 1 },
  };
}
it("preserves complete difference evidence and freezes the persisted unit", () => {
  const f = fixture(),
    value = parsePaymentReconciliationRunResult(f);
  expect(value).toEqual(f);
  expect(Object.isFrozen(value.checks)).toBe(true);
  expect(Object.isFrozen(value.exceptions[0])).toBe(true);
});
it("accepts a stable exception opened in an earlier run", () => {
  const f = fixture();
  const e = f.exceptions[0];
  if (!e) throw Error("fixture");
  e.openedAt = "2026-09-21T23:00:00.000Z";
  expect(parsePaymentReconciliationRunResult(f).exceptions[0]?.openedAt).toBe(e.openedAt);
});
it.each([
  "scope",
  "run",
  "mode",
  "counts",
  "duplicate-check",
  "duplicate-candidate",
  "orphan",
  "missing",
  "reason",
  "severity",
  "future",
  "check-time",
  "completed-time",
])("rejects corrupt result %s", (kind) => {
  const f = fixture(),
    c = f.checks[0],
    e = f.exceptions[0];
  if (!c || !e) throw Error("fixture");
  if (kind === "scope") c.storeReference = id(9);
  if (kind === "run") c.runReference = id(9);
  if (kind === "mode") f.run.mode = "DailySettlement";
  if (kind === "counts") f.counts.Matched = 1;
  if (kind === "duplicate-check") f.checks.push({ ...c, candidateReference: id(9) });
  if (kind === "duplicate-candidate") f.checks.push({ ...c, checkReference: id(9) });
  if (kind === "orphan") e.exceptionReference = id(9);
  if (kind === "missing") f.exceptions = [];
  if (kind === "reason") e.reason = "AmountMismatch";
  if (kind === "severity") e.severity = "Critical";
  if (kind === "future") e.openedAt = "2026-09-23T00:00:00.000Z";
  if (kind === "check-time") c.checkedAt = "2026-09-21T23:59:00.000Z";
  if (kind === "completed-time") f.completedAt = "2026-09-21T23:59:00.000Z";
  expect(() => parsePaymentReconciliationRunResult(f)).toThrow();
});
it("accepts an empty completed run without claiming exceptions", () => {
  const f = fixture();
  f.checks = [];
  f.exceptions = [];
  f.counts.Difference = 0;
  expect(parsePaymentReconciliationRunResult(f).checks).toEqual([]);
});

it("accepts only preserved older exception opening, never changed financial evidence", () => {
  const proposed = fixture(),
    saved = fixture();
  const e = saved.exceptions[0],
    c = saved.checks[0];
  if (!e || !c) throw Error("fixture");
  e.openedAt = "2026-09-21T23:00:00.000Z";
  expect(equivalentPaymentReconciliationResult(proposed, saved)).toBe(true);
  expect(equivalentPaymentReconciliationResult(saved, proposed)).toBe(false);
  c.providerRefundedAmount = money(1000n);
  expect(equivalentPaymentReconciliationResult(proposed, saved)).toBe(false);
});
it("compares check and exception identities independently of read order", () => {
  const a = fixture();
  const c = a.checks[0],
    e = a.exceptions[0];
  if (!c || !e) throw Error("fixture");
  a.checks.push({
    ...c,
    checkReference: id(10),
    candidateReference: id(11),
    exceptionReference: id(12),
  });
  a.exceptions.push({ ...e, exceptionReference: id(12), candidateReference: id(11) });
  a.counts.Difference = 2;
  expect(
    equivalentPaymentReconciliationResult(a, {
      ...a,
      checks: [...a.checks].reverse(),
      exceptions: [...a.exceptions].reverse(),
    }),
  ).toBe(true);
});
