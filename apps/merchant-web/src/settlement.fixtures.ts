/** WP-2423 P1 test fixtures for the settlement view; synthetic values only. */
const id = (n: number) => `018f7700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
export const SETTLEMENT_REFS = Object.freeze({ run: id(1), check: id(2), exception: id(3) });
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
      runs: [
        {
          runReference: SETTLEMENT_REFS.run,
          mode: "DailySettlement",
          scheduledAt: "2026-09-22T08:05:00.000Z",
          cutoffAt: "2026-09-22T08:00:00.000Z",
          completedAt: "2026-09-22T08:06:00.000Z",
          counts: { Matched: 13, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 1 },
        },
      ],
      differences: [
        {
          checkReference: SETTLEMENT_REFS.check,
          runReference: SETTLEMENT_REFS.run,
          checkedAt: "2026-09-22T08:05:30.000Z",
          outcome: "Difference",
          differenceReason: "RefundMismatch",
          settlementReference: "SETTLE-2026-09-21-01",
          internalStatus: "Captured",
          providerStatus: "Captured",
          currencyCode: "CAD",
          internalCapturedMinor: "1130",
          providerCapturedMinor: "1130",
          internalRefundedMinor: "0",
          providerRefundedMinor: "1130",
          exceptionReference: SETTLEMENT_REFS.exception,
        },
      ],
    },
    projectedAt: "2026-09-22T09:00:00.000Z",
  };
}
