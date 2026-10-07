import { describe, expect, it } from "vitest";
import { parseStoreReceiptLines } from "../domain/store-receipt.js";

const id = (n: number) => "01909a15-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const line = (overrides: Record<string, unknown> = {}) => ({
  lineReference: id(1),
  itemReference: id(2),
  locationReference: id(3),
  lotCode: null,
  expiryDate: null,
  acceptedQuantity: "5",
  rejectedQuantity: "0",
  damagedQuantity: "0",
  discrepancyReason: null,
  unitCostMinor: 1850,
  temperatureCelsius: null,
  ...overrides,
});
describe("WP-2423 Store receipt lines", () => {
  it("accepts a fully rejected line with its reason and a chilled temperature", () => {
    expect(
      parseStoreReceiptLines([
        line({
          acceptedQuantity: "0",
          rejectedQuantity: "3",
          discrepancyReason: "WRONG_ITEM",
          temperatureCelsius: "-18.5",
        }),
      ]),
    ).toHaveLength(1);
  });
  it.each([
    ["no quantity at all", line({ acceptedQuantity: "0" })],
    ["damage without a reason", line({ damagedQuantity: "1" })],
    ["a reason without damage", line({ discrepancyReason: "QUALITY" })],
    ["an unknown reason", line({ rejectedQuantity: "1", discrepancyReason: "LOST" })],
    ["a missing cost", line({ unitCostMinor: null })],
    ["a fractional cost", line({ unitCostMinor: 18.5 })],
    ["an out-of-range temperature", line({ temperatureCelsius: "75" })],
    ["a negative quantity", line({ acceptedQuantity: "-1" })],
  ])("refuses %s", (_label, value) => {
    expect(() => parseStoreReceiptLines([value])).toThrow();
  });
  it("refuses an empty receipt", () => {
    expect(() => parseStoreReceiptLines([])).toThrow();
  });
});
