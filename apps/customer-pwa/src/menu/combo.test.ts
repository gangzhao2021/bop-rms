import { describe, expect, it } from "vitest";
import { comboLineAllergenText, comboLineChoices } from "./combo-allergens.js";
import { comboDishAllergens, isCombo, missingComboPart } from "./menu-families.js";
import type { MenuOptionRule, MenuSellable, MenuView } from "./types.js";

const id = (n: number) => `018f7710-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const [sour, wonton, rice] = [id(1), id(2), id(3)];
const option = (optionReference: string, name: string) => ({
  optionReference,
  name,
  maximumQuantity: 1,
  conflictOptionReferences: [],
  selectedByDefault: false,
  price: { amount: "0.00", currency: "CAD" },
});
const part = (name: string, options: MenuOptionRule["options"]): MenuOptionRule => ({
  name,
  comboPart: true,
  minimumSelections: 1,
  maximumSelections: 1,
  options,
});
const peanut = { name: "Peanuts", classification: "Contains" as const };
const wheat = { name: "Wheat", classification: "Contains" as const };
const combo: MenuSellable = {
  sellableReference: id(10),
  name: "Combo for two (TEST)",
  description: null,
  photo: null,
  presentationRole: "Standard",
  pinned: false,
  availability: "Available",
  price: { amount: "28.80", currency: "CAD" },
  allergens: [peanut, wheat],
  // Hot and sour soup: peanuts; wonton soup: wheat; fried rice: none.
  allergensByChoice: {
    options: [sour, wonton, rice],
    outcomes: [[peanut], [wheat]],
    sets: [
      [0, 0, 2],
      [1, 1, 2],
    ],
  },
  optionRules: [
    part("汤", [option(sour, "酸辣汤"), option(wonton, "馄饨汤")]),
    part("主食", [option(rice, "炒饭")]),
  ],
};
const menu: MenuView = {
  name: "TEST menu",
  locale: "zh-Hans",
  effectiveFrom: "2026-10-28T00:00:00.000Z",
  effectiveUntil: null,
  sections: [{ sectionReference: id(20), name: "套餐", sellables: [combo] }],
};

describe("combos for guests (WP-2423 item 8 ⑥ part 4)", () => {
  it("shows each dish's allergens inside its part", () => {
    expect(isCombo(combo)).toBe(true);
    expect(comboDishAllergens(combo, sour)).toEqual([peanut]);
    expect(comboDishAllergens(combo, wonton)).toEqual([wheat]);
    expect(comboDishAllergens(combo, rice)).toEqual([]);
    expect(comboDishAllergens({ ...combo, allergensByChoice: undefined }, sour)).toBeNull();
  });

  it("names the part still to choose in, until every part is chosen", () => {
    expect(missingComboPart(combo, new Map())).toBe("汤");
    expect(missingComboPart(combo, new Map([[sour, 1]]))).toBe("主食");
    expect(
      missingComboPart(
        combo,
        new Map([
          [sour, 1],
          [rice, 1],
        ]),
      ),
    ).toBeNull();
  });

  it("gives the cart and the table the chosen dishes and their allergens", () => {
    expect(comboLineChoices(menu, combo.sellableReference, [wonton, rice])).toBe("馄饨汤, 炒饭");
    expect(comboLineAllergenText(menu, combo.sellableReference, [wonton, rice])).toBe(
      "Your choices: contains Wheat.",
    );
    expect(comboLineAllergenText(menu, combo.sellableReference, [sour])).toBe(
      "Ask staff about allergens in your choices.",
    );
    expect(comboLineAllergenText(menu, id(99), [sour])).toBeNull();
  });
});
