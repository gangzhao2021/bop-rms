import { expect, it } from "vitest";
import { parseTipAmount } from "./tip-amount.js";
it("requires an explicit exact CAD amount, including zero, without rounding", () => {
  for (const [input, expected] of [
    ["0", "0"],
    ["0.01", "1"],
    ["1.2", "120"],
    ["92233720368547758.07", "9223372036854775807"],
  ] as const)
    expect(parseTipAmount(input)).toBe(expected);
  for (const input of ["", " ", "-1", ".5", "01", "1e2", "1.001", "92233720368547758.08"])
    expect(parseTipAmount(input)).toBeNull();
});
