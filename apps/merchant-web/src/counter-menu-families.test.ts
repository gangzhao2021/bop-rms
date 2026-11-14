import { describe, expect, it } from "vitest";
import { counterMenuFamilies, type CounterMenuItem } from "./staff-order-entry.js";

const item = (n: number, version: string | null, name: string): CounterMenuItem => ({
  sellableReference: "018f0f58-767a-7f3b-a1d0-" + n.toString().padStart(12, "0"),
  productVersionReference: version,
  name,
  available: true,
  priceMinor: "450",
  rules: [],
});

describe("counter: one tile per drink, sizes as its buttons", () => {
  it("groups the SKUs of one Product version named '<Product> — <Size>', in menu order", () => {
    const families = counterMenuFamilies([
      item(1, "v-latte", "Latte — Small (8 oz)"),
      item(2, "v-bread", "Banana Bread"),
      item(3, "v-latte", "Latte — Large (16 oz)"),
    ]);
    expect(families.map((family) => family.name)).toEqual(["Latte", "Banana Bread"]);
    expect(families[0]?.sizes.map((size) => size.label)).toEqual(["Small (8 oz)", "Large (16 oz)"]);
    expect(families[1]?.sizes.map((size) => size.label)).toEqual(["Banana Bread"]);
  });
  it("never merges by name alone, or when the names disagree", () => {
    // Same name prefix, different Product versions: two tiles.
    expect(
      counterMenuFamilies([
        item(1, "v-a", "Latte — Small (8 oz)"),
        item(2, "v-b", "Latte — Large (16 oz)"),
      ]),
    ).toHaveLength(2);
    // Same Product version without a shared "<Product> — " name: kept apart.
    expect(
      counterMenuFamilies([item(1, "v-a", "Latte small"), item(2, "v-a", "Latte large")]),
    ).toHaveLength(2);
    // No Product version from the menu: kept apart.
    expect(
      counterMenuFamilies([
        item(1, null, "Latte — Small (8 oz)"),
        item(2, null, "Latte — Large (16 oz)"),
      ]),
    ).toHaveLength(2);
  });
});
