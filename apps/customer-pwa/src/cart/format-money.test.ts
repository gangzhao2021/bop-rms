import { describe, expect, it } from "vitest";
import { formatCartMoney } from "./format-money.js";

describe("WP-2226 customer CAD presentation", () => {
  it.each([
    ["0", "$0.00"],
    ["1", "$0.01"],
    ["-1", "-$0.01"],
    ["1130", "$11.30"],
    ["-1130", "-$11.30"],
    ["9223372036854775807", "$92,233,720,368,547,758.07"],
    ["-9223372036854775808", "-$92,233,720,368,547,758.08"],
  ])("displays %s without floating-point loss", (amountMinor, expected) => {
    expect(formatCartMoney({ amountMinor, currency: "CAD" })).toBe(expected);
  });

  it("does not guess unsupported precision or malformed amounts", () => {
    expect(formatCartMoney({ amountMinor: "100", currency: "USD" })).toBe("USD 1.00");
    for (const amountMinor of ["", "1.20", "NaN", "1e3", " 100", "001"])
      expect(formatCartMoney({ amountMinor, currency: "CAD" })).toBe("Amount unavailable");
  });
});
