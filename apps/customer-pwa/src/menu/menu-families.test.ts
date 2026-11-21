import { describe, expect, it } from "vitest";
import {
  compactAllergenLine,
  configuredItemTotal,
  familyAllergens,
  familyPriceText,
  familySoldOut,
  findMenuFamily,
  groupMenuFamilies,
  primaryVariant,
} from "./menu-families.js";
import type { MenuOptionRule, MenuSellable, MenuView } from "./types.js";

const id = (n: number) => `018f7700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const flatWhite = id(100);
const mocha = id(101);

function item(
  n: number,
  name: string,
  amount: string | null,
  extra: Partial<MenuSellable> = {},
): MenuSellable {
  return {
    sellableReference: id(n),
    productVersionReference: id(200 + n),
    name,
    description: null,
    photo: null,
    presentationRole: "Standard",
    pinned: false,
    availability: "Available",
    price: amount === null ? null : { amount, currency: "CAD" },
    allergens: [],
    optionRules: [],
    ...extra,
  };
}

// The v15 DEMO coffee section as published: each size is its own sellable of one Product version.
const small = item(1, "Flat White — Small (8 oz)", "4.25", {
  productVersionReference: flatWhite,
  allergens: [{ name: "Milk", classification: "Contains" }],
});
const regular = item(2, "Flat White — Regular (12 oz)", "4.95", {
  productVersionReference: flatWhite,
  description: "Double ristretto with velvety steamed milk.",
  allergens: [{ name: "Milk", classification: "Contains" }],
});
const large = item(3, "Flat White — Large (16 oz)", "5.45", {
  productVersionReference: flatWhite,
  allergens: [
    { name: "Milk", classification: "Contains" },
    { name: "Soy", classification: "CrossContactPossible" },
  ],
});
const mochaSmall = item(4, "Mocha — Small (8 oz)", "4.75", { productVersionReference: mocha });
const mochaLarge = item(5, "Mocha — Large (16 oz)", "5.75", {
  productVersionReference: mocha,
  availability: "SoldOut",
});
const latte = item(6, "DEMO Latte", "10.00");

describe("WP-2423 one card per Product", () => {
  it("groups the sizes of one Product into one item named after the Product", () => {
    const families = groupMenuFamilies([small, latte, regular, large, mochaSmall, mochaLarge]);
    expect(families.map((family) => family.name)).toEqual(["Flat White", "DEMO Latte", "Mocha"]);
    expect(families[0]?.variants.map((variant) => variant.label)).toEqual([
      "Small (8 oz)",
      "Regular (12 oz)",
      "Large (16 oz)",
    ]);
    expect(families[1]?.variants).toHaveLength(1);
    expect(families[1]?.variants[0]?.label).toBe("DEMO Latte");
  });

  it("never merges items unless both the Product version and the name prefix agree", () => {
    const sharedVersionOtherNames = [
      item(10, "Rice bowl", "13.50", { productVersionReference: id(300) }),
      item(11, "Green tea", "3.00", { productVersionReference: id(300) }),
    ];
    expect(groupMenuFamilies(sharedVersionOtherNames)).toHaveLength(2);
    const samePrefixOtherProducts = [
      item(12, "Tea — Earl Grey", "3.25"),
      item(13, "Tea — Sencha", "3.25"),
    ];
    expect(groupMenuFamilies(samePrefixOtherProducts)).toHaveLength(2);
    const withoutVersion = (value: MenuSellable): MenuSellable => {
      const copy = { ...value };
      delete copy.productVersionReference;
      return copy;
    };
    const previewWithoutVersions = [withoutVersion(small), withoutVersion(regular)];
    expect(groupMenuFamilies(previewWithoutVersions)).toHaveLength(2);
    const repeatedSize = [small, { ...regular, name: "Flat White — Small (8 oz)" }];
    expect(groupMenuFamilies(repeatedSize)).toHaveLength(2);
  });

  it("prices the card from the lowest size and plainly when every size costs the same", () => {
    const [flat, single, mochaFamily] = groupMenuFamilies([
      small,
      regular,
      large,
      latte,
      mochaSmall,
      mochaLarge,
    ]);
    if (!flat || !single || !mochaFamily) throw new Error("fixture");
    expect(familyPriceText(flat)).toBe("From $4.25");
    expect(familyPriceText(single)).toBe("$10.00");
    const samePrice = groupMenuFamilies([small, { ...regular, price: small.price }])[0];
    if (!samePrice) throw new Error("fixture");
    expect(familyPriceText(samePrice)).toBe("$4.25");
    const partlyPriced = groupMenuFamilies([small, { ...regular, price: null }])[0];
    if (!partlyPriced) throw new Error("fixture");
    expect(familyPriceText(partlyPriced)).toBe("From $4.25");
    const unpriced = groupMenuFamilies([{ ...latte, price: null }])[0];
    if (!unpriced) throw new Error("fixture");
    expect(familyPriceText(unpriced)).toBeNull();
    expect(familySoldOut(mochaFamily)).toBe(false);
    expect(primaryVariant(mochaFamily).sellable).toBe(mochaSmall);
  });

  it("opens the first size that can be ordered and is sold out only when every size is", () => {
    const family = groupMenuFamilies([{ ...small, availability: "SoldOut" }, regular])[0];
    if (!family) throw new Error("fixture");
    expect(primaryVariant(family).sellable).toBe(regular);
    const gone = groupMenuFamilies([
      { ...small, availability: "SoldOut" },
      { ...regular, availability: "SoldOut" },
    ])[0];
    if (!gone) throw new Error("fixture");
    expect(familySoldOut(gone)).toBe(true);
  });

  it("finds an item's family on the published menu", () => {
    const menu: MenuView = {
      name: "DEMO Menu",
      locale: "en-CA",
      effectiveFrom: "2026-10-18T12:00:00.000Z",
      effectiveUntil: null,
      sections: [
        { sectionReference: id(50), name: "Bakery", sellables: [latte] },
        { sectionReference: id(51), name: "Coffee", sellables: [small, regular, large] },
      ],
    };
    expect(findMenuFamily(menu, large.sellableReference)?.name).toBe("Flat White");
    expect(findMenuFamily(menu, latte.sellableReference)?.variants).toHaveLength(1);
    expect(findMenuFamily(menu, id(999))).toBeNull();
  });
});

describe("WP-2423 compact allergen line", () => {
  it("lists every allergen once, contains before may-contain", () => {
    const family = groupMenuFamilies([small, regular, large])[0];
    if (!family) throw new Error("fixture");
    expect(compactAllergenLine(familyAllergens(family))).toBe("Contains Milk · May contain Soy");
    expect(
      compactAllergenLine([
        { name: "Tree nuts", classification: "CrossContactPossible" },
        { name: "Wheat", classification: "Contains" },
        { name: "Eggs", classification: "Contains" },
      ]),
    ).toBe("Contains Wheat, Eggs · May contain Tree nuts");
    expect(compactAllergenLine([])).toBeNull();
  });

  it("never understates an allergen another size contains", () => {
    const family = groupMenuFamilies([
      { ...small, allergens: [{ name: "Soy", classification: "CrossContactPossible" }] },
      { ...regular, allergens: [{ name: "Soy", classification: "Contains" }] },
    ])[0];
    if (!family) throw new Error("fixture");
    expect(compactAllergenLine(familyAllergens(family))).toBe("Contains Soy");
  });
});

describe("WP-2423 configured item total", () => {
  const milk: MenuOptionRule = {
    name: "Milk",
    minimumSelections: 1,
    maximumSelections: 1,
    options: [
      {
        optionReference: id(60),
        name: "Whole milk",
        maximumQuantity: 1,
        conflictOptionReferences: [],
        selectedByDefault: true,
        price: { amount: "0", currency: "CAD" },
      },
      {
        optionReference: id(61),
        name: "Oat milk",
        maximumQuantity: 1,
        conflictOptionReferences: [],
        selectedByDefault: false,
        price: { amount: "0.75", currency: "CAD" },
      },
    ],
  };
  const shots: MenuOptionRule = {
    name: "Extra shot",
    minimumSelections: 0,
    maximumSelections: 3,
    options: [
      {
        optionReference: id(62),
        name: "Espresso shot",
        maximumQuantity: 3,
        conflictOptionReferences: [],
        selectedByDefault: false,
        price: { amount: "1.0000", currency: "CAD" },
      },
    ],
  };
  it("adds each chosen option times its quantity, times the item quantity, exactly", () => {
    const selected = new Map([
      [id(61), 1],
      [id(62), 2],
    ]);
    expect(configuredItemTotal(regular, [milk, shots], selected, 1)).toBe("$7.70");
    expect(configuredItemTotal(regular, [milk, shots], selected, 3)).toBe("$23.10");
    expect(configuredItemTotal(item(7, "Odd", "0.10"), [], new Map(), 3)).toBe("$0.30");
  });
  it("shows no total while anything chosen is still to be priced", () => {
    const unpriced: MenuOptionRule = {
      ...shots,
      options: shots.options.map((option) => ({ ...option, price: null })),
    };
    expect(configuredItemTotal(regular, [unpriced], new Map([[id(62), 1]]), 1)).toBeNull();
    expect(configuredItemTotal({ ...regular, price: null }, [], new Map(), 1)).toBeNull();
    expect(configuredItemTotal(regular, [], new Map(), 0)).toBeNull();
  });
});
