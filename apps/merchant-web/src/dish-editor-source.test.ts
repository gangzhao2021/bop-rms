import { describe, expect, it } from "vitest";
import { groupStart, typedExtras, type TypedChoice } from "./dish-editor-source.js";
import type { ProductOptionSetChoice } from "./product-pages.js";

const id = (n: number) => "0190996c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
/** A group as the dish read shows it, its choices named in the staff member's language. */
const group = (names: readonly string[]): ProductOptionSetChoice =>
  ({
    optionSetReference: id(1),
    name: "Toppings",
    archived: false,
    comboPart: false,
    displayStyle: "MultiChoice",
    minimum: 0,
    maximum: null,
    perOptionMaximum: 1,
    options: names.map((name, index) => ({
      optionReference: id(10 + index),
      name,
      offered: true,
    })),
  }) as ProductOptionSetChoice;
const typed: readonly TypedChoice[] = [
  { name: "Pearls", nameZh: "珍珠", extra: "0.80" },
  { name: "Pudding", nameZh: "", extra: "1.20" },
];

describe("WP-2423 item 3 D: extras typed in New choice group", () => {
  it("reach the dish whatever language the staff read the choices in", () => {
    const usual = new Map<string, string>();
    // English staff see the English names; Chinese staff see 珍珠, and Pudding (no Chinese name).
    for (const shown of [
      ["Pearls", "Pudding"],
      ["珍珠", "Pudding"],
    ]) {
      const made = group(shown);
      expect(groupStart(made, usual, typedExtras(made, typed))).toEqual(
        new Map([
          [id(10), "0.80"],
          [id(11), "1.20"],
        ]),
      );
    }
  });
  it("leave a choice that does not match what was typed at its usual extra", () => {
    const made = group(["Pearls", "Coconut jelly"]);
    const usual = new Map([[id(11), "0.90"]]);
    expect(groupStart(made, usual, typedExtras(made, typed))).toEqual(
      new Map([
        [id(10), "0.80"],
        [id(11), "0.90"],
      ]),
    );
    // A group read with another number of choices matches nothing.
    expect(typedExtras(group(["Pearls"]), typed).size).toBe(0);
  });
});
