import { expect, it } from "vitest";
import { compAmountMinor } from "./ItemCompAction.js";

const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
// 28.00 dish, 13 % tax: what the database's rule takes off (net, then tax in proportion).
const fish = {
  subtotal: money("2800"),
  discount: money("0"),
  tax: money("364"),
  fee: money("0"),
};

it("WP-2423 item 8 ① segment 2: shows exactly what a comp or discount takes off", () => {
  expect(compAmountMinor(fish, "Comp", null, null)).toBe(3164n);
  // 15 % of 28.00 = 4.20; tax 3.64 × 4.20 / 28.00 = 0.546 → 0.55.
  expect(compAmountMinor(fish, "Percent", 15, null)).toBe(420n + 55n);
  // 5.00 off; tax 3.64 × 5 / 28 = 0.65.
  expect(compAmountMinor(fish, "Amount", null, 500n)).toBe(500n + 65n);
  // An amount off the whole dish is a comp; more, or nothing, is not offered.
  expect(compAmountMinor(fish, "Amount", null, 2800n)).toBeNull();
  expect(compAmountMinor(fish, "Amount", null, 0n)).toBeNull();
  expect(compAmountMinor(fish, "Percent", 100, null)).toBeNull();
  expect(compAmountMinor(fish, "Percent", null, null)).toBeNull();
});
