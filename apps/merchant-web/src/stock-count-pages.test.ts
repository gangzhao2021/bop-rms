import { describe, expect, it } from "vitest";
import { validCountedQuantity } from "./stock-count-pages.js";
import { availableQuantityText, centsText, wasteQuantityAllowed } from "./store-waste-pages.js";

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
  it.each([
    ["100.6959", "100.69"],
    ["4.500", "4.5"],
    ["12.0000", "12"],
    ["7", "7"],
    ["0.25", "0.25"],
    ["0.0040", "0.004"],
    ["0.0100", "0.01"],
  ])("shows %s available as %s (rounded down, never a hidden remainder)", (value, shown) => {
    expect(availableQuantityText(value)).toBe(shown);
    // What is shown can always be recorded against what is available.
    expect(wasteQuantityAllowed(shown, 6, value)).toBe(true);
  });
  it("formats cents", () => {
    expect(centsText(4900)).toBe("49.00");
    expect(centsText(7)).toBe("0.07");
  });
});
