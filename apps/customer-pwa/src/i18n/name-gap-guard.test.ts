import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { LanguageRoot, t } from "./i18n.js";
import { zhHans } from "./zh-Hans.js";

/**
 * Batch 46 (v15 overnight 45): one rule for a name or label filled into a Chinese sentence, the
 * same as on the staff screens (v15 b12): the template has no space of its own next to it, so a
 * Chinese name meets the sentence directly ("牛肉面现在不供应") and a name whose edge is Latin
 * letters or digits gets one space where it meets Chinese ("已选择在 Lane Dessert (TEST) 自取。").
 * Live, the same kind of sentence had three spacings, one of them a name joined to a translated
 * piece with a space in code.
 *
 * Times, numbers and amounts keep their spaces ("营业至 {time}"), and a table's own label keeps
 * the batch 42 rule (a space where its Latin letters meet Chinese). The dining-table sentences
 * listed below are left for the after-close pages bundle, which edits them.
 */
const names = ["name", "dish", "dishes", "item", "option", "store", "storeDisplayName"];
const keptForTables = (english: string) =>
  english.includes("{table}") ||
  [
    "This table at {storeDisplayName} isn’t open yet",
    "Your table at {storeDisplayName} is confirmed for dine-in.",
    "Welcome to {storeDisplayName}",
    "added {dishes}",
    "removed {dishes}",
    "{dish} now ×{quantity}",
    "{name} {price} per person · {count} at this table (added by staff).",
  ].includes(english);

afterEach(() => {
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
});

it("no Chinese text puts a space between a filled-in name and a Chinese character", () => {
  const han = "[\\u3400-\\u9fff（）：，。“”]";
  const spaced = new RegExp(
    `\\{(?:${names.join("|")})\\} (?=${han})|(?<=${han}) \\{(?:${names.join("|")})\\}`,
    "u",
  );
  const found = Object.entries(zhHans)
    .filter(([english, chinese]) => !keptForTables(english) && spaced.test(chinese))
    .map(([english]) => english);
  expect(found).toEqual([]);
});

/**
 * Batch 47 (v15 b46 live): a numbered placeholder is as often a name or a list of names as a
 * number. Live the guest menu read "含有 花生、芝麻、大豆、小麦和黑小麦" and "可能含有 芝麻", Chinese
 * joined to a Chinese list with a space, because "{value1}" was not checked. These keep their
 * space because what is filled in is a number, a time or a pickup code.
 */
const numberedNotNames = new Set([
  "Choice group {value1}",
  "Order {orderNumber}. Pickup code {value1}",
  "Served {value1} of {quantity}",
  "This round will be cancelled at {value1}. ",
  " If it isn't paid by {value1}, it is cancelled and nobody is charged.",
  "Pay by {value1}, or it is cancelled and nobody is charged.",
  "You’ve made a lot of codes in the last few minutes. You can make another at {value1}, or ask a staff member for one.",
  "opens at {value1}",
  "until {value1}",
  "{name} allows at most {value1}.",
]);

it("no Chinese text puts a space between a numbered placeholder and a Chinese character", () => {
  const han = "[\\u3400-\\u9fff（）：，。“”、]";
  const spaced = new RegExp(`\\{value[0-9]*\\} (?=${han})|(?<=${han}) \\{value[0-9]*\\}`, "u");
  const found = Object.entries(zhHans)
    .filter(([english, chinese]) => !numberedNotNames.has(english) && spaced.test(chinese))
    .map(([english]) => english);
  expect(found).toEqual([]);
  // Each kept entry still exists, so the list does not outlive its texts.
  expect([...numberedNotNames].filter((english) => zhHans[english] === undefined)).toEqual([]);
});

it("reads the live allergen lines with the list joined to the Chinese around it", () => {
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
  // As live on the TM2 menu (担担面), joined by the guest list separator.
  expect(t("Contains {value1}", { value1: "花生、芝麻、大豆、小麦和黑小麦" })).toBe(
    "含有花生、芝麻、大豆、小麦和黑小麦",
  );
  expect(t("May contain {value1}", { value1: "芝麻" })).toBe("可能含有芝麻");
  expect(t("contains {value1}", { value1: "花生" })).toBe("含有花生");
  expect(t("may contain {value1}", { value1: "芝麻" })).toBe("可能含有芝麻");
  // An allergen the owner wrote in Latin letters keeps the b12 space.
  expect(t("Contains {value1}", { value1: "MSG" })).toBe("含有 MSG");
  expect(
    t("{value1} allows at most {maximumSelections}.", { value1: "辣度", maximumSelections: 1 }),
  ).toBe("辣度最多可选 1 项。");
  expect(
    t("{value1} requires at least {minimumSelections}.", {
      value1: "Toppings",
      minimumSelections: 2,
    }),
  ).toBe("Toppings 至少要选 2 项。");
});

it("a sentence about the Store is one translated text, never a name joined to a piece with a space", () => {
  const root = new URL("..", import.meta.url).pathname;
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return files(path);
      return path.endsWith(".tsx") && !path.includes(".test.") ? [path] : [];
    });
  // "{state.storeDisplayName} {t("isn’t taking orders right now")}" read "… (TEST) 现在不接单".
  const joined =
    /\{[\w.?]*(?:[Nn]ame|[Ll]abel)\}\s*(?:\{" "\}\s*)?\{t\("|\{t\("[^"]*"\)\}(?:\{" "\}|[ \t]+)\{[\w.?]*(?:[Nn]ame|[Ll]abel)\}/u;
  const found = files(root).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        joined.test(line) ? [`${relative(root, path)}:${index + 1}`] : [],
      ),
  );
  expect(found).toEqual([]);
});

it("reads the live sentences with the Store's name spaced as on the staff screens", () => {
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
  expect(
    t("Pickup from {storeDisplayName} is selected.", {
      storeDisplayName: "巷口糖水 Lane Dessert (TEST)",
    }),
  ).toBe("已选择在巷口糖水 Lane Dessert (TEST) 自取。");
  expect(
    t("{storeDisplayName} isn’t taking orders right now", {
      storeDisplayName: "半糖奶茶 Half Sugar Tea (TEST)",
    }),
  ).toBe("半糖奶茶 Half Sugar Tea (TEST) 现在不接单");
  expect(t("{name} isn't available right now.", { name: "牛肉面" })).toBe("牛肉面现在不供应。");
  expect(
    t("Pickup from {storeDisplayName} is selected.", { storeDisplayName: "Lane Dessert" }),
  ).toBe("已选择在 Lane Dessert 自取。");
  // A Latin dish name, as staff read it ("Mia 申请").
  expect(t("{name} isn't available right now.", { name: "Dan dan noodles" })).toBe(
    "Dan dan noodles 现在不供应。",
  );
  expect(
    t("How {storeDisplayName} handles your contact details:", { storeDisplayName: "面馆" }),
  ).toBe("面馆如何处理您的联系方式：");
  expect(t("Ask a staff member at {storeDisplayName}.", { storeDisplayName: "面馆" })).toBe(
    "请询问面馆的店员。",
  );
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
  expect(
    t("{storeDisplayName} isn’t taking orders right now", { storeDisplayName: "Noodle Bar" }),
  ).toBe("Noodle Bar isn’t taking orders right now");
  expect(
    t("How {storeDisplayName} handles your contact details:", { storeDisplayName: "Noodle Bar" }),
  ).toBe("How Noodle Bar handles your contact details:");
});
