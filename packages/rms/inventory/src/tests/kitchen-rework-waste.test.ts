import { describe, expect, it } from "vitest";
import { KitchenReworkWasteError, kitchenReworkWasteQuantity } from "../index.js";

describe("WP-2423 Q26 Kitchen remake waste quantity", () => {
  it("takes the remade portions' share of the line demand at ledger precision", () => {
    const share = (
      lineDemand: string,
      lineQuantity: number,
      reworkQuantity: number,
      precision = 4,
    ) => kitchenReworkWasteQuantity({ lineDemand, precision, lineQuantity, reworkQuantity });
    expect(share("0.5", 2, 1)).toBe("0.25");
    expect(share("0.5", 2, 2)).toBe("0.5");
    expect(share("1", 3, 1)).toBe("0.3333");
    expect(share("1", 3, 2)).toBe("0.6667");
    expect(share("12", 4, 1, 0)).toBe("3");
    expect(share("0.0001", 3, 1)).toBe("0");
  });
  it("refuses impossible shares", () => {
    for (const input of [
      { lineDemand: "1", precision: 4, lineQuantity: 1, reworkQuantity: 2 },
      { lineDemand: "1", precision: 4, lineQuantity: 0, reworkQuantity: 1 },
      { lineDemand: "-1", precision: 4, lineQuantity: 1, reworkQuantity: 1 },
      { lineDemand: "1.00001", precision: 4, lineQuantity: 1, reworkQuantity: 1 },
      { lineDemand: "1", precision: 7, lineQuantity: 1, reworkQuantity: 1 },
    ])
      expect(() => kitchenReworkWasteQuantity(input)).toThrow(KitchenReworkWasteError);
  });
});
