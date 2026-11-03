import { expect, it } from "vitest";
import { cashQuickAmounts } from "./TableCheckout.js";

it("Owner 2026-11-03: offers the exact cash amount, then the next bills a guest hands over", () => {
  expect(cashQuickAmounts(1670n)).toEqual([1670n, 2000n, 5000n, 10000n]);
  expect(cashQuickAmounts(490n)).toEqual([490n, 500n, 1000n, 2000n]);
  expect(cashQuickAmounts(12000n)).toEqual([12000n]);
});
