import { describe, expect, it } from "vitest";
import { calculateRecipeDemandQuantity } from "../domain/recipe-demand-quantity.js";
const unit = {
  unitCode: "KG",
  dimension: "Mass",
  displayPrecision: 2,
  ledgerPrecision: 4,
  roundingMode: "HalfEven",
};
const part = (n: string, d = "1") => ({ quantityNumerator: n, quantityDenominator: d });
describe("Recipe demand to Inventory precision", () => {
  it.each([
    ["HalfEven", "50", "0"],
    ["HalfEven", "150", "0.0002"],
    ["HalfUp", "50", "0.0001"],
    ["Down", "199", "0.0001"],
  ])("rounds %s %s to %s", (roundingMode, n, quantity) => {
    expect(
      calculateRecipeDemandQuantity({ unit: { ...unit, roundingMode }, quantities: [part(n)] }),
    ).toMatchObject({ quantity, roundingApplied: true });
  });
  it("sums rational contributions before rounding once", () => {
    expect(
      calculateRecipeDemandQuantity({
        unit,
        quantities: [part("100", "3"), part("100", "3"), part("100", "3")],
      }),
    ).toMatchObject({
      quantity: "0.0001",
      exactMicrounitsNumerator: "100",
      exactMicrounitsDenominator: "1",
      roundingApplied: false,
    });
  });
  it("preserves values beyond binary floating point precision", () => {
    expect(
      calculateRecipeDemandQuantity({
        unit: { ...unit, ledgerPrecision: 6 },
        quantities: [part("9007199254740993123456")],
      }).quantity,
    ).toBe("9007199254740993.123456");
  });
  it("does not impose a fixed numeric precision absent from the stock ledger schema", () => {
    expect(
      calculateRecipeDemandQuantity({ unit, quantities: [part("1" + "0".repeat(30))] }).quantity,
    ).toBe("1" + "0".repeat(24));
  });
  it("represents zero without inventing a minimum stock movement", () => {
    expect(calculateRecipeDemandQuantity({ unit, quantities: [] }).quantity).toBe("0");
  });
  it.each([part("-1"), part("1", "0"), part("01"), part("1.5"), part("1" + "0".repeat(1024))])(
    "rejects invalid or oversized quantities %j",
    (quantity) => {
      expect(() => calculateRecipeDemandQuantity({ unit, quantities: [quantity] })).toThrow();
    },
  );
  it("rejects sparse and accessor data without invoking it", () => {
    expect(() => calculateRecipeDemandQuantity({ unit, quantities: new Array(1) })).toThrow();
    let called = false;
    const value = Object.defineProperty({}, "unit", {
      enumerable: true,
      get() {
        called = true;
        return unit;
      },
    });
    Object.defineProperty(value, "quantities", { enumerable: true, value: [] });
    expect(() => calculateRecipeDemandQuantity(value)).toThrow();
    expect(called).toBe(false);
  });
});
