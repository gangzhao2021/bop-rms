import { describe, expect, it } from "vitest";
import {
  dishEditorSource,
  groupStart,
  typedExtras,
  type TypedChoice,
} from "./dish-editor-source.js";
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

it("WP-2423: a choice removed from its group since the dish was saved is not sent back", () => {
  const toppings = group(["Pearls", "Pudding"]);
  const source = dishEditorSource(id(90), {
    product: {
      taxClasses: [],
      optionSetChoices: [toppings],
      product: {
        name: "Milk tea",
        // Pudding (11) is still in the group; 19 was archived since.
        optionSets: [{ optionSetReference: id(1), enabledOptionReferences: [id(11), id(19)] }],
      },
    },
    optionPrices: { products: [] },
  });
  expect([...(source.chosen.get(id(1))?.keys() ?? [])]).toEqual([id(11)]);
});

it("WP-2423 M25: a choice ticked again starts from what this dish last charged for it", () => {
  const toppings = group(["Pearls", "Pudding"]);
  const source = dishEditorSource(id(90), {
    product: {
      taxClasses: [],
      optionSetChoices: [toppings],
      product: {
        name: "Milk tea",
        // Pearls (10) was unticked; pudding (11) is on the dish.
        optionSets: [{ optionSetReference: id(1), enabledOptionReferences: [id(11)] }],
      },
    },
    optionPrices: {
      products: [
        {
          productReference: id(90),
          optionSets: [
            {
              options: [{ optionReference: id(11), priceMinor: "90", pending: null }],
              lastPrices: { [id(10)]: "80" },
            },
          ],
        },
      ],
    },
  });
  expect(source.last.get(id(10))).toBe("0.80");
  expect(source.last.get(id(11))).toBe("0.90");
});
