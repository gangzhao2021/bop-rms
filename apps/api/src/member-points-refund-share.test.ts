import { describe, expect, it } from "vitest";
import { ledgerOrderPaidMinor, refundedPointsTargets } from "./member-points-refund-share.js";

describe("refundedPointsTargets (v15 M60: one rule for the sweep and the receipt's offer)", () => {
  const refund = (paymentIntentReference: string, amountMinor: bigint) => ({
    paymentIntentReference,
    amountMinor,
  });
  it("takes back the refunded share of a whole bill, rounded down, and all of it once refunded in full", () => {
    const earned = [{ sourceReference: "s1", points: 120 }];
    const settlements = [
      { settlementReference: "s1", onlinePaymentReference: "p1", totalMinor: 4500n },
    ];
    expect(refundedPointsTargets({ earned, settlements, refunds: [], paidMinor: 0n })).toEqual([0]);
    expect(
      refundedPointsTargets({
        earned,
        settlements,
        refunds: [refund("p1", 1000n)],
        paidMinor: 0n,
      }),
    ).toEqual([26]);
    // A fully refunded receipt: nothing is left to offer.
    expect(
      refundedPointsTargets({
        earned,
        settlements,
        refunds: [refund("p1", 1000n), refund("p1", 3500n)],
        paidMinor: 0n,
      }),
    ).toEqual([120]);
  });
  it("a paid part answers only for its own refunds", () => {
    const settlements = [
      { settlementReference: "a", onlinePaymentReference: null, totalMinor: 2000n },
      { settlementReference: "b", onlinePaymentReference: "pb", totalMinor: 2000n },
    ];
    expect(
      refundedPointsTargets({
        earned: [
          { sourceReference: "a", points: 60 },
          { sourceReference: "b", points: 60 },
        ],
        settlements,
        refunds: [refund("a:cash-1", 1000n)],
        paidMinor: 0n,
      }),
    ).toEqual([30, 0]);
  });
  it("a pickup's paid rounds answer for all the Order's refunds against what the ledger says was paid", () => {
    const ledger = {
      payments: [
        {
          orderReference: "o",
          paymentIntentReference: "i1",
          orderBatchReference: "b1",
          totalMinor: 3000n,
        },
      ],
      refundedPayments: [
        {
          orderReference: "o",
          paymentIntentReference: "i1",
          orderBatchReference: "b1",
          totalMinor: 3000n,
        },
        {
          orderReference: "x",
          paymentIntentReference: "i9",
          orderBatchReference: "b9",
          totalMinor: 999n,
        },
      ],
    };
    expect(ledgerOrderPaidMinor(ledger, "o")).toBe(3000n);
    expect(
      refundedPointsTargets({
        earned: [{ sourceReference: "b1", points: 90 }],
        settlements: [],
        refunds: [refund("i1", 1000n)],
        paidMinor: 3000n,
      }),
    ).toEqual([30]);
  });
});
