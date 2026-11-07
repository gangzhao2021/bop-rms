import { describe, expect, it } from "vitest";
import { comboDishChoices, saveComboCommand } from "./ComboEditor.js";
import type { MenuSectionRow } from "./one-store-menu.js";
import { MenuPageError, parseMenuCombos, type MenuCombo } from "./store-menu-pages.js";

const id = (n: number) => "01a4d900-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const size = (sku: string, sizeName: string | null = null) => ({
  skuReference: sku,
  sizeName,
  priceMinor: "650",
  pendingPriceMinor: null,
  soldOut: false,
  hidden: false,
  featured: false,
});
const dish = (sku: string, name: string, nameZh: string, sizes = [size(sku)]) => ({
  skuReference: sku,
  name,
  nameZh,
  sizeName: null,
  priceMinor: "650",
  pendingPriceMinor: null,
  productReference: id(90),
  soldOut: false,
  hidden: false,
  featured: false,
  allergens: { source: "None" as const, declared: [] },
  sizes,
});
const rows: MenuSectionRow[] = [
  {
    sectionReference: id(1),
    code: "SOUPS",
    name: "Soups",
    nameZh: "汤",
    dishes: [
      dish(id(10), "Hot and sour soup (TEST)", "酸辣汤"),
      dish(id(11), "Wonton soup (TEST)", "馄饨汤", [size(id(11), "Small"), size(id(12), "Large")]),
    ],
  },
  {
    sectionReference: id(2),
    code: "COMBOS",
    name: "Combos",
    nameZh: "套餐",
    dishes: [dish(id(20), "Combo for two (TEST)", "二人套餐")],
  },
];
const combo: MenuCombo = {
  bundleReference: id(30),
  aggregateVersion: 2,
  name: "Combo for two (TEST)",
  nameZh: "二人套餐",
  description: "",
  descriptionZh: "",
  priceMinor: "2880",
  productReference: id(31),
  skuReference: id(20),
  state: "Listed",
  slots: [
    {
      code: "SLOT-1",
      name: "Soup",
      nameZh: "汤",
      minimum: 1,
      maximum: 1,
      dishes: [{ skuReference: id(10), upgradeMinor: "0" }],
    },
  ],
};
const slot = (overrides = {}) => ({
  code: null,
  name: "Soup",
  nameZh: "汤",
  choose: "1",
  optional: false,
  dishes: new Map([
    [id(10), "0.00"],
    [id(12), "1.00"],
  ]),
  ...overrides,
});
const input = (overrides = {}) => ({
  operationReference: id(40),
  menuReference: id(41),
  combo: null,
  name: " Combo for two (TEST) ",
  nameZh: "二人套餐",
  description: "",
  descriptionZh: "",
  price: "28.80",
  tax: id(42),
  section: "COMBOS",
  slots: [slot()],
  ...overrides,
});

describe("combo editor (WP-2423 item 8 ⑥ part 4)", () => {
  it("offers every size on the menu except combos themselves", () => {
    expect(comboDishChoices(rows, [combo]).map((d) => [d.name, d.nameZh])).toEqual([
      ["Hot and sour soup (TEST)", "酸辣汤"],
      ["Wonton soup (TEST) — Small", "馄饨汤"],
      ["Wonton soup (TEST) — Large", "馄饨汤"],
    ]);
  });

  it("builds the save: one price, each part with how many guests choose and extra prices", () => {
    expect(saveComboCommand(input())).toEqual({
      action: "SaveCombo",
      operationReference: id(40),
      menuReference: id(41),
      bundleReference: null,
      expectedAggregateVersion: null,
      sectionCode: "COMBOS",
      name: "Combo for two (TEST)",
      nameZh: "二人套餐",
      description: "",
      descriptionZh: "",
      taxClassificationReference: id(42),
      priceMinor: "2880",
      slots: [
        {
          code: null,
          name: "Soup",
          nameZh: "汤",
          minimum: 1,
          maximum: 1,
          dishes: [
            { skuReference: id(10), upgradeMinor: "0" },
            { skuReference: id(12), upgradeMinor: "100" },
          ],
        },
      ],
    });
    // An existing combo is saved against the version read; an optional part may be skipped.
    expect(
      saveComboCommand(input({ combo, slots: [slot({ code: "SLOT-1", optional: true })] })),
    ).toMatchObject({
      bundleReference: id(30),
      expectedAggregateVersion: 2,
      slots: [{ code: "SLOT-1", minimum: 0, maximum: 1 }],
    });
  });

  it("waits until the combo is complete", () => {
    for (const changed of [
      input({ name: " " }),
      input({ price: "28.8.0" }),
      input({ tax: "" }),
      input({ slots: [] }),
      input({ slots: [slot({ name: "" })] }),
      input({ slots: [slot({ choose: "3" })] }),
      input({ slots: [slot({ choose: "0" })] }),
      input({ slots: [slot({ dishes: new Map([[id(10), "one"]]) })] }),
    ])
      expect(saveComboCommand(changed)).toBeNull();
  });

  it("reads the combos and refuses anything else", () => {
    expect(parseMenuCombos({ combos: [combo] })).toEqual([combo]);
    expect(() => parseMenuCombos({ combos: [{ ...combo, state: "Draft" }] })).toThrow(
      MenuPageError,
    );
    expect(() => parseMenuCombos({})).toThrow(MenuPageError);
  });
});
