import { describe, expect, it } from "vitest";
import {
  orderPriceReductionAmounts,
  withBillTaxRoundingShares,
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
