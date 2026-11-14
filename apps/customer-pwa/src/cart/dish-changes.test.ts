import { afterEach, expect, it } from "vitest";
import {
  changesSignature,
  dishChangeText,
  lineAllergenLine,
  quoteDishChanges,
  recordFirstPricedLines,
} from "./dish-changes.js";
import {
  acceptSeenPrices,
  clearSeenPrices,
  recordFirstSeenPrices,
  seenPriceChanges,
} from "./seen-prices.js";
import type { MenuView } from "../menu/types.js";
import type { CartItemView } from "./types.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageRoot } from "../i18n/i18n.js";

const setLanguageForTest = (language: "en" | "zh-Hans") =>
  renderToStaticMarkup(createElement(LanguageRoot, { initial: language, children: () => null }));

const id = (n: number) => "018f7a10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const cart = id(1);
const item = {
  cartItemReference: id(2),
  sellableReference: id(3),
  displayName: "Wonton noodle soup",
  quantity: 2,
  configuration: [],
  customerNote: null,
  lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
  warnings: [],
} as unknown as CartItemView;
const menu = (mayContain: string[]) =>
  ({
    sections: [
      {
        sellables: [
          {
            sellableReference: id(3),
            allergens: mayContain.map((name) => ({ name, classification: "CrossContactPossible" })),
            optionRules: [],
          },
        ],
      },
    ],
  }) as unknown as MenuView;
const first = (amountMinor: string, changes: readonly ("Name" | "Allergens")[] = []) => ({
  sinceAdded: [
    {
      cartItemReference: id(2),
      quantity: 2,
      subtotal: { amountMinor, currency: "CAD" },
      changes,
    },
  ],
});
afterEach(() => {
  clearSeenPrices();
  setLanguageForTest("en");
});

it("price-hold-dish-changes (DEC-PRICE-HOLD §3): the Store's renamed dish and allergens now are named in plain words", () => {
  const changes = quoteDishChanges(
    first("2500", ["Name", "Allergens"]),
    [item],
    menu(["Sesame seeds"]),
  );
  expect(changes).toEqual([
    {
      cartItemReference: id(2),
      dish: "Wonton noodle soup",
      name: true,
      allergens: true,
      allergensNow: "May contain Sesame seeds",
    },
  ]);
  expect(dishChangeText(changes[0] as (typeof changes)[number])).toBe(
    "Wonton noodle soup was renamed since you added it. Wonton noodle soup allergens now: May contain Sesame seeds.",
  );
  // Allergens the menu no longer lists, and a menu not read yet: never "nothing changed".
  expect(lineAllergenLine(menu([]), id(3), [])).toBe("No allergens listed");
  const unknown = quoteDishChanges(first("2500", ["Allergens"]), [item], null)[0];
  expect(unknown === undefined ? "" : dishChangeText(unknown)).toBe(
    "Wonton noodle soup allergens changed since you added it. Ask staff before you order.",
  );
  // Only what changed; lines the Store lists for price alone are no dish change.
  expect(quoteDishChanges(first("2500"), [item], null)).toEqual([]);
  expect(changesSignature([], [])).toBeNull();
});

it("price-hold-dish-changes (v15 batch 6): the Store's first price for a line is the guest's first, after a reload too", () => {
  // The page (reloaded) saw $25.50 first from today's menu; the Store first priced it at $25.00.
  recordFirstSeenPrices(cart, [
    { cartItemReference: id(2), quantity: 2, amountMinor: 2550n, currency: "CAD" },
  ]);
  recordFirstPricedLines(cart, first("2500"));
  expect(
    seenPriceChanges(cart, [
      { cartItemReference: id(2), quantity: 2, amountMinor: 2550n, currency: "CAD" },
    ]),
  ).toEqual([expect.objectContaining({ beforeMinor: 2500n, afterMinor: 2550n, direction: "up" })]);
  // Accepted here: the Store's record no longer brings the old price back.
  acceptSeenPrices(cart, [
    { cartItemReference: id(2), quantity: 2, amountMinor: 2550n, currency: "CAD" },
  ]);
  recordFirstPricedLines(cart, first("2500"));
  expect(
    seenPriceChanges(cart, [
      { cartItemReference: id(2), quantity: 2, amountMinor: 2550n, currency: "CAD" },
    ]),
  ).toEqual([]);
});

it("v15 2026-11-11 b10: a rename says what the name was and is, or which other language's name changed", () => {
  const change = {
    cartItemReference: id(2),
    dish: "Beef noodles",
    name: true,
    allergens: false,
    allergensNow: null,
  };
  // Only the Chinese name changed: the English reader is told so, never the same name twice.
  const zhOnly = {
    ...change,
    renamed: [{ locale: "zh-Hans-CA", from: "牛肉面", to: "红烧牛肉面" }],
  };
  expect(dishChangeText(zhOnly)).toBe(
    "Beef noodles: its Chinese name changed from 牛肉面 to 红烧牛肉面. The name you see here is the same.",
  );
  // The English name changed: before and now.
  expect(
    dishChangeText({
      ...change,
      dish: "Braised beef noodles",
      renamed: [{ locale: "en-CA", from: "Beef noodles", to: "Braised beef noodles" }],
    }),
  ).toBe("Beef noodles is now called Braised beef noodles.");
  // An older server: the plain sentence.
  expect(dishChangeText(change)).toBe("Beef noodles was renamed since you added it.");
  setLanguageForTest("zh-Hans");
  expect(dishChangeText({ ...zhOnly, dish: "红烧牛肉面" })).toBe("牛肉面现在叫红烧牛肉面。");
  expect(
    dishChangeText({
      ...change,
      dish: "牛肉面",
      renamed: [{ locale: "en-CA", from: "Beef noodles", to: "Braised beef noodles" }],
    }),
  ).toBe("牛肉面的英文名称从Beef noodles改为Braised beef noodles。你看到的名称没有变。");
});
