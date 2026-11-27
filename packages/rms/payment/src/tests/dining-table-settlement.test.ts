import { describe, expect, it } from "vitest";
import {
  DiningTableSettlementError,
  planDiningTableSettlement,
  roundCashTotal,
} from "../domain/dining-table-settlement.js";

const round = (n: number, roundMinor: bigint) => ({
  orderBatchReference: "b" + n,
  submissionReference: "s" + n,
  sequence: n,
  roundMinor,
});

describe("WP-2423 DEC-DINE-IN-PAY-LATER cash rounding to 5 cents", () => {
  it.each([
    [2340n, 2340n, 0n],
    [2341n, 2340n, -1n],
    [2342n, 2340n, -2n],
    [2343n, 2345n, 2n],
    [2344n, 2345n, 1n],
    [2345n, 2345n, 0n],
    [2346n, 2345n, -1n],
    [2347n, 2345n, -2n],
    [2348n, 2350n, 2n],
    [2349n, 2350n, 1n],
  ])("rounds %s to %s (rounding %s)", (total, rounded, rounding) => {
    expect(roundCashTotal(total)).toEqual({ roundedMinor: rounded, roundingMinor: rounding });
  });
  it("never rounds below zero or accepts a negative total", () => {
    expect(roundCashTotal(2n)).toEqual({ roundedMinor: 0n, roundingMinor: -2n });
    expect(() => roundCashTotal(-1n)).toThrow(DiningTableSettlementError);
  });
});

describe("WP-2423 DEC-DINE-IN-PAY-LATER one table payment split by round", () => {
  it("puts the tip and the cash rounding on the last round; the lines add up to what was taken", () => {
    const plan = planDiningTableSettlement({
      method: "Cash",
      rounds: [round(2, 1130n), round(1, 2260n)],
      tipMinor: 512n,
      tenderedMinor: 5000n,
    });
    // 2260 + 1130 + 512 = 3902 → 3900 in cash.
    expect(plan).toMatchObject({
      roundsMinor: 3390n,
      tipMinor: 512n,
      roundingMinor: -2n,
      totalMinor: 3900n,
      tenderedMinor: 5000n,
      changeMinor: 1100n,
    });
    expect(plan.lines).toEqual([
      {
        orderBatchReference: "b1",
        submissionReference: "s1",
        roundMinor: 2260n,
        tipMinor: 0n,
        roundingMinor: 0n,
      },
      {
        orderBatchReference: "b2",
        submissionReference: "s2",
        roundMinor: 1130n,
        tipMinor: 512n,
        roundingMinor: -2n,
      },
    ]);
    expect(
      plan.lines.reduce(
        (sum, line) => sum + line.roundMinor + line.tipMinor + line.roundingMinor,
        0n,
      ),
    ).toBe(plan.totalMinor);
  });
  it("never rounds a card payment and takes no tendered amount for it", () => {
    const plan = planDiningTableSettlement({
      method: "CardMachine",
      rounds: [round(1, 2263n)],
      tipMinor: 0n,
      tenderedMinor: null,
    });
    expect(plan).toMatchObject({ totalMinor: 2263n, roundingMinor: 0n, changeMinor: null });
    expect(() =>
      planDiningTableSettlement({
        method: "CardMachine",
        rounds: [round(1, 1n)],
        tipMinor: 0n,
        tenderedMinor: 100n,
      }),
    ).toThrow(DiningTableSettlementError);
  });
  it("refuses cash short of the rounded total, nothing owed, and repeated rounds", () => {
    const short = () =>
      planDiningTableSettlement({
        method: "Cash",
        rounds: [round(1, 2263n)],
        tipMinor: 0n,
        tenderedMinor: 2260n,
      });
    expect(short).toThrow(
      expect.objectContaining({ code: "DINING_TABLE_SETTLEMENT_TENDER_SHORT" }),
    );
    // 22.63 rounds to 22.65: exactly 22.65 is enough, with no change.
    expect(
      planDiningTableSettlement({
        method: "Cash",
        rounds: [round(1, 2263n)],
        tipMinor: 0n,
        tenderedMinor: 2265n,
      }).changeMinor,
    ).toBe(0n);
    expect(() =>
      planDiningTableSettlement({ method: "Cash", rounds: [], tipMinor: 0n, tenderedMinor: 100n }),
    ).toThrow(expect.objectContaining({ code: "DINING_TABLE_SETTLEMENT_NOTHING_OWED" }));
    expect(() =>
      planDiningTableSettlement({
        method: "Cash",
        rounds: [round(1, 100n), { ...round(1, 100n) }],
        tipMinor: 0n,
        tenderedMinor: 500n,
      }),
    ).toThrow(DiningTableSettlementError);
  });
});
