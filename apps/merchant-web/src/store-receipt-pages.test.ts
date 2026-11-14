import { describe, expect, it } from "vitest";
import { lineCostCents } from "./store-receipt-pages.js";

describe("WP-2423 receipt line value", () => {
  it.each([
    ["6", 289, 1734],
    ["2.25", 1850, 4162],
    ["0.5", 3, 2],
    ["0.5", 5, 2],
    ["1.5", 5, 8],
    ["0", 999, 0],
  ])("%s x %i cents = %i cents (half to even)", (quantity, unit, total) => {
    expect(lineCostCents(quantity, unit)).toBe(total);
  });
});
