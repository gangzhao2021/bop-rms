import { describe, expect, it } from "vitest";
import { moneyText, parseMoney, parseOptionPriceView } from "./store-option-prices-page.js";

describe("WP-2423 option price page helpers", () => {
  it("reads and writes money in minor units without floating point", () => {
    expect(parseMoney("0.75", 2)).toBe("75");
    expect(parseMoney(".5", 2)).toBe("50");
    expect(parseMoney("1", 2)).toBe("100");
    expect(parseMoney("0", 2)).toBe("0");
    expect(parseMoney("1.005", 2)).toBeNull();
    expect(parseMoney("-1", 2)).toBeNull();
    expect(parseMoney("", 2)).toBeNull();
    expect(moneyText("75", 2)).toBe("0.75");
    expect(moneyText("0", 2)).toBe("0.00");
    expect(moneyText("1250", 2)).toBe("12.50");
  });
  it("accepts only option price views", () => {
    expect(() => parseOptionPriceView({ screenId: "PRICE-BOOK-LIST" })).toThrow();
    expect(
      parseOptionPriceView({
        screenId: "PRICE-OPTION-LIST",
        products: [],
        currency: { code: "CAD", minorUnitExponent: 2 },
      }).products,
    ).toEqual([]);
  });
});
