/** WP-2423 P1 test fixtures for the settlement view; synthetic values only. */
const id = (n: number) => `018f7700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
export const SETTLEMENT_REFS = Object.freeze({
  settlementRun: id(1),
  statementCheck: id(2),
  exception: id(3),
  operationalRun: id(4),
  differenceCheck: id(5),
  unresolvedCheck: id(6),
});
const counts = (partial: Partial<Record<string, number>>) => ({
  Matched: 0,
  Healed: 0,
  Unresolved: 0,
  Unavailable: 0,
  Difference: 0,
  ...partial,
});
/** A closed Toronto day (04:00 to 04:00 local) with a matched statement and two payments to look at. */
export function settlementViewFixture() {
  return {
    screenId: "PAY-RECONCILIATION",
    storeLabel: "Training Store",
    businessDate: "2026-09-21",
    window: {
      startsAt: "2026-09-21T08:00:00.000Z",
      endsAt: "2026-09-22T08:00:00.000Z",
      timeZone: "America/Toronto",
      status: "Closed",
    },
    captured: { count: 14, amountMinor: "123450", currencyCode: "CAD" },
    refunded: { count: 1, amountMinor: "1130", currencyCode: "CAD" },
    reconciliation: {
      settlement: {
        run: {
          runReference: SETTLEMENT_REFS.settlementRun,
          mode: "DailySettlement",
          scheduledAt: "2026-09-22T12:00:00.000Z",
          cutoffAt: "2026-09-22T12:00:00.000Z",
          completedAt: "2026-09-22T12:00:06.000Z",
          counts: counts({ Matched: 1 }),
        },
        checks: [
          {
            checkReference: SETTLEMENT_REFS.statementCheck,
            runReference: SETTLEMENT_REFS.settlementRun,
            checkedAt: "2026-09-22T12:00:05.000Z",
            outcome: "Matched",
            differenceReason: null,
            settlementReference: "SETTLE-2026-09-21-01",
            internalStatus: null,
            providerStatus: null,
            currencyCode: "CAD",
            internalCapturedMinor: "123450",
            providerCapturedMinor: "123450",
            internalRefundedMinor: "1130",
            providerRefundedMinor: "1130",
            exceptionReference: null,
          },
        ],
      },
      operational: {
        runCount: 240,
        latestRun: {
          runReference: SETTLEMENT_REFS.operationalRun,
          mode: "Operational",
          scheduledAt: "2026-09-22T07:58:00.000Z",
          cutoffAt: "2026-09-22T07:58:00.000Z",
          completedAt: "2026-09-22T07:58:01.000Z",
          counts: counts({ Matched: 12, Unresolved: 1, Difference: 1 }),
        },
        paymentCount: 14,
        outcomes: counts({ Matched: 12, Unresolved: 1, Difference: 1 }),
      },
      differences: [
        {
          checkReference: SETTLEMENT_REFS.differenceCheck,
          runReference: SETTLEMENT_REFS.operationalRun,
          checkedAt: "2026-09-22T07:58:00.700Z",
          outcome: "Difference",
          differenceReason: "RefundMismatch",
          settlementReference: null,
          internalStatus: "Captured",
          providerStatus: "Captured",
          currencyCode: "CAD",
          internalCapturedMinor: "1130",
          providerCapturedMinor: "1130",
          internalRefundedMinor: "0",
          providerRefundedMinor: "1130",
          exceptionReference: SETTLEMENT_REFS.exception,
        },
        {
          checkReference: SETTLEMENT_REFS.unresolvedCheck,
          runReference: SETTLEMENT_REFS.operationalRun,
          checkedAt: "2026-09-22T07:58:00.500Z",
          outcome: "Unresolved",
          differenceReason: null,
          settlementReference: null,
          internalStatus: "RequiresCustomerAction",
          providerStatus: "RequiresCustomerAction",
          currencyCode: "CAD",
          internalCapturedMinor: "0",
          providerCapturedMinor: "0",
          internalRefundedMinor: "0",
          providerRefundedMinor: "0",
          exceptionReference: null,
        },
      ],
      differenceCount: 2,
    },
    projectedAt: "2026-09-22T13:00:00.000Z",
  };
}
/** The same day while it is still open: checks so far, no settlement run yet. */
export function openSettlementReconciliationFixture() {
  const closed = settlementViewFixture().reconciliation;
  return { ...closed, settlement: null };
}
/** A day with no checks at all. */
export function emptySettlementReconciliationFixture() {
  return {
    settlement: null,
    operational: { runCount: 0, latestRun: null, paymentCount: 0, outcomes: counts({}) },
    differences: [],
    differenceCount: 0,
  };
}
