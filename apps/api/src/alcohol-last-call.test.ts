import { describe, expect, it } from "vitest";
import { alcoholLastCall, alcoholMenuFact, withinAlcoholHours } from "./alcohol-sale-rule.js";

describe("WP-2423 (M93, Owner decision 18): last call 30 minutes before the 2:00 cutoff", () => {
  it("is last call from 1:30 to before 2:00, never at other times", () => {
    expect(alcoholLastCall("01:29:59")).toBe(false);
    expect(alcoholLastCall("01:30:00")).toBe(true);
    expect(alcoholLastCall("01:59:59")).toBe(true);
    expect(alcoholLastCall("02:00:00")).toBe(false);
    expect(alcoholLastCall("23:30:00")).toBe(false);
    expect(withinAlcoholHours("01:59:00")).toBe(true);
  });
  it("keeps a dish orderable at last call and says so", () => {
    const fact = { availability: "Available" as const };
    const sale = { skus: new Set(["x"]), offered: true, withinHours: true };
    expect(alcoholMenuFact(fact, { ...sale, lastCall: true }, "DineIn")).toEqual({
      availability: "Available",
      alcohol: "LastCall",
    });
    expect(alcoholMenuFact(fact, sale, "DineIn")).toEqual({
      availability: "Available",
      alcohol: "OnSale",
    });
  });
});
