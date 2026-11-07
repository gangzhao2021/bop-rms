import { describe, expect, it } from "vitest";
import { orderPriceReductionAmounts } from "../infrastructure/persistence/order-item-price-reduction-store.js";

describe("WP-2423 item 8 ① segment 2: a manager's comp or discount on one dish", () => {
  const dish = { netMinor: 2800n, taxMinor: 364n, feeMinor: 0n };
  it("takes the whole dish for a comp, tax and fee included", () => {
    expect(orderPriceReductionAmounts(dish, { kind: "Comp" })).toEqual({
      netMinor: 2800n,
      taxMinor: 364n,
      feeMinor: 0n,
      totalMinor: 3164n,
    });
  });
  it("takes a percentage or an amount off the net and tax in proportion, half up", () => {
    expect(orderPriceReductionAmounts(dish, { kind: "Percent", percent: 15 })).toEqual({
      netMinor: 420n,
      taxMinor: 55n,
      feeMinor: 0n,
      totalMinor: 475n,
    });
    expect(orderPriceReductionAmounts(dish, { kind: "Amount", netMinor: 500n })).toEqual({
      netMinor: 500n,
      taxMinor: 65n,
      feeMinor: 0n,
      totalMinor: 565n,
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
