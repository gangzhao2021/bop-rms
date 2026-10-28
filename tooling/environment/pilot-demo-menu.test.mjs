import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { expect, it } from "vitest";

/**
 * WP-2423 item 8 ③ (Owner 2026-10-27 decision 8): the Chinese TEST demo menu is well formed — every
 * dish and choice named in English and Chinese, prices in whole cents and marked TEST, choices
 * from the groups it defines, allergens from the Canadian priority list the menu uses.
 */
const allergens = new Set([
  "CRUSTACEAN_MOLLUSC",
  "EGG",
  "FISH",
  "GLUTEN",
  "MILK",
  "MUSTARD",
  "PEANUT",
  "SESAME",
  "SOY",
  "SULPHITES",
  "TREE_NUT",
  "WHEAT_TRITICALE",
]);
const named = (names) =>
  typeof names?.["en-CA"] === "string" &&
  names["en-CA"].trim() !== "" &&
  typeof names?.["zh-Hans-CA"] === "string" &&
  /\p{Script=Han}/u.test(names["zh-Hans-CA"]);
const cents = (value) => Number.isSafeInteger(value) && value >= 0;

it("is a bilingual TEST menu of about 20 dishes with spice, portion and rice choices", async () => {
  const menu = JSON.parse(
    await readFile(
      new URL("../../docs/pilot/demo-menu-chinese-test.json", import.meta.url),
      "utf8",
    ),
  );
  expect(menu.label).toMatch(/TEST/u);
  expect(menu.currencyCode).toBe("CAD");
  const groups = new Map(menu.optionGroups.map((group) => [group.key, group]));
  expect([...groups.keys()]).toEqual(expect.arrayContaining(["spice", "portion", "rice"]));
  for (const group of menu.optionGroups) {
    expect(named(group.names), group.key).toBe(true);
    expect(group.rule.minimum).toBeLessThanOrEqual(group.rule.maximum);
    expect(group.options.length).toBeGreaterThan(0);
    for (const option of group.options) {
      expect(named(option.names), option.key).toBe(true);
      expect(cents(option.priceMinor), option.key).toBe(true);
    }
    // A required single choice has exactly one preselected option; an optional one has none.
    expect(group.options.filter((option) => option.default === true).length).toBe(
      group.rule.minimum === 1 ? 1 : 0,
    );
  }
  const dishes = menu.sections.flatMap((section) => {
    expect(named(section.names)).toBe(true);
    return section.dishes;
  });
  expect(dishes.length).toBeGreaterThanOrEqual(18);
  expect(dishes.length).toBeLessThanOrEqual(24);
  const english = new Set();
  for (const dish of dishes) {
    expect(named(dish.names), dish.names?.["en-CA"]).toBe(true);
    expect(english.has(dish.names["en-CA"]), "unique name").toBe(false);
    english.add(dish.names["en-CA"]);
    expect(cents(dish.priceMinor) && dish.priceMinor > 0, dish.names["en-CA"]).toBe(true);
    expect(dish.description === null || named(dish.description)).toBe(true);
    for (const code of dish.allergens) expect(allergens.has(code), code).toBe(true);
    for (const key of dish.options) expect(groups.has(key), key).toBe(true);
  }
  expect(dishes.some((dish) => dish.options.includes("spice"))).toBe(true);
  expect(dishes.some((dish) => dish.options.includes("rice"))).toBe(true);
});
