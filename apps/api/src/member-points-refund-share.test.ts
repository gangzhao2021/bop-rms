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

  /**
   * v15 b61 live (TM2 orders 61 and 62): a two-phone table, each phone paying its own part online,
   * staff refunding phone A. The settlements and refunds have the shape the claim and the sweep
   * read: Payment's settlement records (listByOrders) and the ledger's table refunds, keyed to the
   * settlement's round line ("<settlement>:<line>"). Points follow the money each phone kept.
   */
  describe("a split bill paid part by part on the phones (v15 b61 live, orders 61 and 62)", () => {
    const online = (
      settlementReference: string,
      totalMinor: bigint,
      partNumber: number | null,
    ) => ({
      settlementReference,
      onlinePaymentReference: "pay-" + settlementReference,
      totalMinor,
      method: "Online" as const,
      part: partNumber === null ? null : { splitPlanReference: "plan", partNumber },
    });
    const even = [online("set-a", 1413n, 1), online("set-b", 1412n, 2)];
    const a = { sourceReference: "set-a", points: 126 };
    const b = { sourceReference: "set-b", points: 125 };
    const targets = (
      earned: readonly { readonly sourceReference: string; readonly points: number }[],
      settlements: readonly ReturnType<typeof online>[],
      refunds: readonly { paymentIntentReference: string; amountMinor: bigint }[],
    ) => refundedPointsTargets({ earned, settlements, refunds, paidMinor: 2825n });

    it("A refunded in full: B, offered alone before A claims, keeps all of its points", () => {
      const refunds = [refund("set-a:1", 1413n)];
      // Order 61: B was offered 63 (125 less the whole bill's half) and told "after the refund".
      expect(targets([b], even, refunds)).toEqual([0]);
      expect(targets([a], even, refunds)).toEqual([126]);
      expect(targets([a, b], even, refunds)).toEqual([126, 0]);
      expect(targets([b, a], even, refunds)).toEqual([0, 126]);
    });
    it("A refunded in part: A answers for its own refund against its own payment, B for none", () => {
      const refunds = [refund("set-a:1", 800n)];
      // Order 62: B was offered 90; A 55 (126 less 71, its refunded share of $14.13).
      expect(targets([b], even, refunds)).toEqual([0]);
      expect(targets([a], even, refunds)).toEqual([71]);
      expect(targets([a, b], even, refunds)).toEqual([71, 0]);
      // A refund keyed to A's phone payment itself counts as A's too.
      expect(targets([b], even, [refund("pay-set-a", 800n)])).toEqual([0]);
      expect(targets([a], even, [refund("pay-set-a", 800n)])).toEqual([71]);
    });
    it("by dish: parts of different amounts each answer only for their own refunds", () => {
      const byDish = [online("set-a", 1695n, 1), online("set-b", 1130n, 2)];
      const refunds = [refund("set-a:1", 800n)];
      expect(targets([{ sourceReference: "set-b", points: 100 }], byDish, refunds)).toEqual([0]);
      expect(targets([{ sourceReference: "set-a", points: 151 }], byDish, refunds)).toEqual([71]);
      // B refunded too: each its own.
      expect(
        targets(
          [
            { sourceReference: "set-a", points: 151 },
            { sourceReference: "set-b", points: 100 },
          ],
          byDish,
          [...refunds, refund("set-b:1", 565n)],
        ),
      ).toEqual([71, 50]);
    });
    it("one phone paid the whole table: that payment's refunds come off its points (order 78: 180)", () => {
      const whole = [online("set-w", 2825n, null)];
      expect(
        targets([{ sourceReference: "set-w", points: 251 }], whole, [refund("set-w:1", 800n)]),
      ).toEqual([71]);
    });
    it("a refund tied to no payment never reduces a phone that paid its own part online and was not refunded", () => {
      // A card-machine or cash refund the ledger cannot tie to a part.
      const untied = [refund("pi-counter", 800n)];
      expect(targets([b], even, untied)).toEqual([0]);
      // A part paid at the table in cash, earning alone, keeps the rule for such refunds: their
      // share of the whole bill.
      const cashA = { ...even[0], onlinePaymentReference: null, method: "Cash" as const };
      expect(targets([a], [cashA, even[1]] as never, untied)).toEqual([35]);
      // Nor does a refund of A's part ever reach B through that rule.
      expect(targets([b], [cashA, even[1]] as never, [refund("set-a:1", 800n)])).toEqual([0]);
    });
  });
});
