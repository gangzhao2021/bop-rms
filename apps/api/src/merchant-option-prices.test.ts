import { describe, expect, it } from "vitest";
import { optionPriceRuleReference, parseOptionPriceCommandBody } from "./merchant-option-prices.js";

const id = (n: number) => "01909a22-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const price = (change: Record<string, unknown> = {}) => ({
  bindingReference: id(1),
  optionReference: id(2),
  amountMinor: "75",
  expectedAggregateVersion: null,
  replacesPending: false,
  ...change,
});

describe("WP-2423 option prices", () => {
  it("parses price changes and publications", () => {
    const set = parseOptionPriceCommandBody({
      action: "SetPrices",
      operationReference: id(3),
      prices: [price(), price({ optionReference: id(4), amountMinor: "0" })],
    });
    expect(set.action === "SetPrices" && set.prices.map((p) => p.amountMinor)).toEqual(["75", "0"]);
    const publish = parseOptionPriceCommandBody({
      action: "Publish",
      operationReference: id(3),
      rules: [{ ruleReference: id(5), expectedAggregateVersion: 2 }],
    });
    expect(publish.action).toBe("Publish");
  });
  it("refuses negative, fractional or duplicate prices and inconsistent versions", () => {
    const refuse = (prices: unknown[]) =>
      expect(() =>
        parseOptionPriceCommandBody({ action: "SetPrices", operationReference: id(3), prices }),
      ).toThrow("Invalid");
    refuse([price({ amountMinor: "-1" })]);
    refuse([price({ amountMinor: "0.75" })]);
    refuse([price({ amountMinor: "075" })]);
    refuse([price(), price()]);
    refuse([price({ replacesPending: true })]);
    refuse([]);
    expect(() =>
      parseOptionPriceCommandBody({
        action: "Publish",
        operationReference: id(3),
        rules: [{ ruleReference: id(5), expectedAggregateVersion: null }],
      }),
    ).toThrow("Invalid");
  });
  it("owns one stable rule per product option", () => {
    expect(optionPriceRuleReference(id(1), id(2))).toBe(optionPriceRuleReference(id(1), id(2)));
    expect(optionPriceRuleReference(id(1), id(2))).not.toBe(optionPriceRuleReference(id(1), id(4)));
  });
});
