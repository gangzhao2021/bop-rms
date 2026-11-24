import { describe, expect, it } from "vitest";
import {
  orderItemCompAmounts,
  orderItemReductions,
  orderPriceReductionAmounts,
  withBillTaxRoundingShares,
  type OrderPriceReductionRecord,
} from "../infrastructure/persistence/order-item-price-reduction-store.js";

describe("WP-2423 item 8 ① segment 2: a manager's comp or discount on one dish", () => {
  const dish = { netMinor: 2800n, taxMinor: 364n, feeMinor: 0n };
  it("takes the whole dish for a comp, tax and fee included", () => {
    expect(orderPriceReductionAmounts(dish, { kind: "Comp" })).toEqual({
      netMinor: 2800n,
      taxMinor: 364n,
      feeMinor: 0n,
      totalMinor: 3164n,
      taxRoundingMinor: 0n,
    });
  });
  it("takes a percentage or an amount off the net and tax in proportion, half up", () => {
    expect(orderPriceReductionAmounts(dish, { kind: "Percent", percent: 15 })).toEqual({
      netMinor: 420n,
      taxMinor: 55n,
      feeMinor: 0n,
      totalMinor: 475n,
      taxRoundingMinor: 0n,
    });
    expect(orderPriceReductionAmounts(dish, { kind: "Amount", netMinor: 500n })).toEqual({
      netMinor: 500n,
      taxMinor: 65n,
      feeMinor: 0n,
      totalMinor: 565n,
      taxRoundingMinor: 0n,
    });
    expect(
      orderPriceReductionAmounts({ ...dish, feeMinor: 100n }, { kind: "Percent", percent: 50 }),
    ).toMatchObject({ feeMinor: 50n, totalMinor: 1400n + 182n + 50n });
  });
  it("refuses nothing, everything as an amount, more than the dish and impossible percentages", () => {
    for (const choice of [
      { kind: "Amount", netMinor: 0n },
      { kind: "Amount", netMinor: 2800n },
      { kind: "Amount", netMinor: 2801n },
      { kind: "Percent", percent: 0 },
      { kind: "Percent", percent: 100 },
      { kind: "Percent", percent: 12.5 },
    ] as const)
      expect(orderPriceReductionAmounts(dish, choice)).toBeNull();
    expect(orderPriceReductionAmounts({ ...dish, netMinor: 0n }, { kind: "Comp" })).toBeNull();
  });
});

describe("v15 b16 DEC-COMP-BILL-CENT: the whole bill's tax cent on a reduction", () => {
  const line = (item: string, taxMinor: bigint) => ({
    orderBatchReference: "b",
    orderItemReference: item,
    netMinor: 1250n,
    taxMinor,
    feeMinor: 0n,
    totalMinor: 1250n + taxMinor,
    taxRoundingMinor: 0n,
    compedQuantity: 1,
    lineQuantity: 1,
  });
  const plan = {
    orderReference: "o",
    choice: { kind: "Comp" as const, percent: null },
    lines: [line("i1", 163n), line("i2", 163n)],
    totalMinor: 2826n,
  };
  it("puts the cent on the dish's tax and says so, so the records add up to the bill", () => {
    const settled = withBillTaxRoundingShares(plan, new Map([["i2", -1n]]));
    expect(settled.totalMinor).toBe(2825n);
    expect(settled.lines.map((l) => [l.taxMinor, l.totalMinor, l.taxRoundingMinor])).toEqual([
      [163n, 1413n, 0n],
      [162n, 1412n, -1n],
    ]);
    // Applied again with other shares, it starts from the dish's own share, never twice.
    expect(withBillTaxRoundingShares(settled, new Map()).totalMinor).toBe(2826n);
  });
  it("never takes a dish's tax below nothing nor a share beyond nine cents", () => {
    expect(() => withBillTaxRoundingShares(plan, new Map([["i1", -164n]]))).toThrow();
    expect(() => withBillTaxRoundingShares(plan, new Map([["i1", 10n]]))).toThrow();
    expect(() => withBillTaxRoundingShares(plan, new Map([["i1", -10n]]))).toThrow();
    expect(withBillTaxRoundingShares(plan, new Map([["i1", 9n]])).lines[0]?.taxRoundingMinor).toBe(
      9n,
    );
  });
});

describe("batch 60: a comp of some of a line's dishes (1 of 2 × Beef noodles)", () => {
  // v15 b59 live, L59S B: Beef noodles (TEST) $12.50 + 13% HST = $14.13 a bowl; a line of two is
  // $25.00 + $3.25 tax (the line's own quote, tax rounded once on the line).
  const line = { netMinor: 2500n, taxMinor: 325n, feeMinor: 0n };
  it("takes one bowl's price and its half-up share of the line's tax", () => {
    expect(orderItemCompAmounts(line, { lineQuantity: 2, priorQuantity: 0, quantity: 1 })).toEqual({
      netMinor: 1250n,
      taxMinor: 163n,
      feeMinor: 0n,
      totalMinor: 1413n,
      taxRoundingMinor: 0n,
    });
  });
  it("lets the second bowl take what is left, so both comps add up to the line exactly", () => {
    const first = orderItemCompAmounts(line, { lineQuantity: 2, priorQuantity: 0, quantity: 1 });
    const second = orderItemCompAmounts(line, { lineQuantity: 2, priorQuantity: 1, quantity: 1 });
    expect(second).toEqual({
      netMinor: 1250n,
      taxMinor: 162n,
      feeMinor: 0n,
      totalMinor: 1412n,
      taxRoundingMinor: 0n,
    });
    expect((first?.totalMinor ?? 0n) + (second?.totalMinor ?? 0n)).toBe(2825n);
    // The whole line at once is the line's price, as a whole-line comp always was.
    expect(orderItemCompAmounts(line, { lineQuantity: 2, priorQuantity: 0, quantity: 2 })).toEqual(
      orderPriceReductionAmounts(line, { kind: "Comp" }),
    );
  });
  it("shares an amount that does not divide by the dishes without losing a cent", () => {
    const odd = { netMinor: 1000n, taxMinor: 130n, feeMinor: 7n };
    const parts = [0, 1, 2].map((prior) =>
      orderItemCompAmounts(odd, { lineQuantity: 3, priorQuantity: prior, quantity: 1 }),
    );
    expect(parts.map((part) => part?.netMinor)).toEqual([333n, 334n, 333n]);
    expect(parts.reduce((sum, part) => sum + (part?.netMinor ?? 0n), 0n)).toBe(1000n);
    expect(parts.reduce((sum, part) => sum + (part?.taxMinor ?? 0n), 0n)).toBe(130n);
    expect(parts.reduce((sum, part) => sum + (part?.feeMinor ?? 0n), 0n)).toBe(7n);
  });
  it("refuses no dishes, more dishes than are left, part of a dish and a dish with no price", () => {
    for (const asked of [
      { lineQuantity: 2, priorQuantity: 0, quantity: 0 },
      { lineQuantity: 2, priorQuantity: 0, quantity: 3 },
      { lineQuantity: 2, priorQuantity: 1, quantity: 2 },
      { lineQuantity: 2, priorQuantity: 2, quantity: 1 },
      { lineQuantity: 2, priorQuantity: 0, quantity: 1.5 },
      { lineQuantity: 0, priorQuantity: 0, quantity: 1 },
      { lineQuantity: 1000, priorQuantity: 0, quantity: 1 },
    ])
      expect(orderItemCompAmounts(line, asked)).toBeNull();
    expect(
      orderItemCompAmounts(
        { ...line, netMinor: 0n },
        { lineQuantity: 2, priorQuantity: 0, quantity: 1 },
      ),
    ).toBeNull();
    // A cent shared over three dishes leaves a dish that would take nothing off.
    expect(
      orderItemCompAmounts(
        { netMinor: 1n, taxMinor: 0n, feeMinor: 0n },
        { lineQuantity: 3, priorQuantity: 0, quantity: 1 },
      ),
    ).toBeNull();
  });
  it("reads a line's comps as one: what came off, how many dishes and how many are left", () => {
    const record = (n: number, decidedAt: string, totalMinor: bigint, taxMinor: bigint) =>
      ({
        reductionReference: "r" + n,
        operationReference: "op" + n,
        orderReference: "o",
        orderBatchReference: "b",
        orderItemReference: "i1",
        kind: "Comp",
        percent: null,
        netMinor: 1250n,
        taxMinor,
        feeMinor: 0n,
        totalMinor,
        taxRoundingMinor: 0n,
        reasonCode: n === 1 ? "WRONG_DISH" : "LONG_WAIT",
        actorReference: "a" + n,
        decidedAt,
        compedQuantity: 1,
        lineQuantity: 2,
      }) satisfies OrderPriceReductionRecord;
    const one = orderItemReductions([record(1, "2026-11-24T18:00:00.000Z", 1413n, 163n)]).get("i1");
    expect(one).toMatchObject({ compedQuantity: 1, remainingQuantity: 1, totalMinor: 1413n });
    const both = orderItemReductions([
      record(2, "2026-11-24T18:05:00.000Z", 1412n, 162n),
      record(1, "2026-11-24T18:00:00.000Z", 1413n, 163n),
    ]).get("i1");
    expect(both).toMatchObject({
      netMinor: 2500n,
      taxMinor: 325n,
      totalMinor: 2825n,
      compedQuantity: 2,
      lineQuantity: 2,
      remainingQuantity: 0,
      reasonCode: "LONG_WAIT",
      decidedAt: "2026-11-24T18:05:00.000Z",
    });
    expect(both?.records.map((entry) => entry.reductionReference)).toEqual(["r1", "r2"]);
    // A reduction that names no dishes (before batch 60, a percentage, points) covers the line.
    const whole = orderItemReductions([
      { ...record(1, "2026-11-24T18:00:00.000Z", 2825n, 325n), compedQuantity: null },
    ]).get("i1");
    expect(whole).toMatchObject({ compedQuantity: null, remainingQuantity: 0 });
  });
});
