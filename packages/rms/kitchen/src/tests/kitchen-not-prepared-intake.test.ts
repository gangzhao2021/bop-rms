import { describe, expect, it } from "vitest";
import { kitchenLinesNotPrepared } from "../application/kitchen-not-prepared-intake.js";

const line = (name: string) => ({
  orderItemReference: `item-${name}`,
  productReference: `product-${name}`,
  skuReference: `sku-${name}`,
  quantity: 1,
});
const decide = (
  marks: Readonly<Record<string, boolean>>,
  defaults: readonly string[],
  ...names: readonly string[]
) =>
  kitchenLinesNotPrepared(
    names.map(line),
    new Map(
      Object.entries(marks).map(([name, notPrepared]) => [`product-${name}`, { notPrepared }]),
    ),
    new Set(defaults.map((name) => `sku-${name}`)),
  ).map((found) => found.orderItemReference);

describe("WP-2423 item 8a: which lines of a round the kitchen does not prepare", () => {
  it("a dish with no mark and no default goes to the kitchen", () => {
    expect(decide({}, [], "noodles")).toEqual([]);
  });
  it("a size declared a charge or the Store's tea item is left out with no mark", () => {
    expect(decide({}, ["sauce"], "sauce", "noodles")).toEqual(["item-sauce"]);
  });
  it("the Store's own mark wins over the default, either way", () => {
    expect(decide({ sauce: false }, ["sauce"], "sauce")).toEqual([]);
    expect(decide({ water: true }, [], "water")).toEqual(["item-water"]);
    expect(decide({ water: true }, ["water"], "water")).toEqual(["item-water"]);
  });
});
