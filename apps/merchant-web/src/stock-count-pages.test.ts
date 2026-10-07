import { describe, expect, it } from "vitest";
import { validCountedQuantity } from "./stock-count-pages.js";
import { centsText, wasteQuantityAllowed } from "./store-waste-pages.js";

describe("WP-2423 count and waste entry checks", () => {
  it.each([
    ["4.5", 3, true],
    ["4.5555", 3, false],
    ["0", 0, true],
    ["-1", 3, false],
    ["1e3", 3, false],
  ])("count %s at precision %i is %s", (value, precision, ok) => {
    expect(validCountedQuantity(value, precision)).toBe(ok);
  });
  it.each([
    ["0.2", 3, "4.3", true],
    ["4.3", 3, "4.3", true],
    ["4.301", 3, "4.3", false],
    ["0", 3, "4.3", false],
    ["0.25", 1, "4.3", false],
  ])("waste %s at precision %i with %s available is %s", (value, precision, available, ok) => {
    expect(wasteQuantityAllowed(value, precision, available)).toBe(ok);
  });
  it("formats cents", () => {
    expect(centsText(4900)).toBe("49.00");
    expect(centsText(7)).toBe("0.07");
  });
});
