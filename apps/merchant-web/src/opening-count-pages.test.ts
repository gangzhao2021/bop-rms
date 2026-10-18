import { describe, expect, it } from "vitest";
import { centsToDollars, dollarsToCents } from "./opening-count-pages.js";

describe("WP-2423 opening count money input", () => {
  it.each([
    ["18.5", 1850],
    ["18.50", 1850],
    ["0.07", 7],
    ["12", 1200],
    [" 3.20 ", 320],
  ])("converts %s dollars to exact cents", (value, cents) => {
    expect(dollarsToCents(value)).toBe(cents);
  });
  it.each(["1.005", "-1", "1e3", "abc", "", "1,50"])("refuses %s", (value) => {
    expect(dollarsToCents(value)).toBeNull();
  });
  it("formats cents back to dollars", () => {
    expect(centsToDollars(1850)).toBe("18.50");
    expect(centsToDollars(7)).toBe("0.07");
    expect(centsToDollars(null)).toBe("");
  });
});
