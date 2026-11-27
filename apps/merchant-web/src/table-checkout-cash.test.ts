import { expect, it } from "vitest";
import { cashQuickAmounts } from "./TableCheckout.js";

it("Owner 2026-11-03: offers the exact cash amount, then the next bills a guest hands over", () => {
  expect(cashQuickAmounts(1670n)).toEqual([1670n, 2000n, 4000n, 5000n, 10000n]);
  expect(cashQuickAmounts(490n)).toEqual([490n, 500n, 1000n, 2000n, 4000n]);
});

it("M146: the amounts in between are offered too, not only the exact amount and $100", () => {
  expect(cashQuickAmounts(5755n)).toEqual([5755n, 6000n, 8000n, 10000n]);
  expect(cashQuickAmounts(1240n)).toEqual([1240n, 1500n, 2000n, 4000n, 5000n]);
  expect(cashQuickAmounts(12000n)).toEqual([12000n, 12500n, 13000n, 14000n, 15000n]);
});
