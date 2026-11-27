import { expect, it } from "vitest";
import { everyBatchUnitClaimed } from "./order-batch-refund-coverage.js";

// WP-2423 M10: "refunded in full" before acceptance is counted in dishes, not in money.
const units = new Map([
  ["fries", 2],
  ["tea", 1],
]);
it("is all of it only once every unit of every dish is claimed, the tip left or not", () => {
  expect(everyBatchUnitClaimed(units, new Map())).toBe(false);
  expect(
    everyBatchUnitClaimed(
      units,
      new Map([
        ["fries", new Set([1])],
        ["tea", new Set([1])],
      ]),
    ),
  ).toBe(false);
  // Earlier requests and this one together.
  expect(
    everyBatchUnitClaimed(units, new Map([["fries", new Set([1, 2])]]), [
      { orderItemReference: "tea", refundUnitOrdinals: [1] },
    ]),
  ).toBe(true);
  // A unit of another order's dish never counts.
  expect(
    everyBatchUnitClaimed(units, new Map([["fries", new Set([1, 2])]]), [
      { orderItemReference: "coffee", refundUnitOrdinals: [1] },
    ]),
  ).toBe(false);
  expect(everyBatchUnitClaimed(new Map(), new Map())).toBe(false);
});
