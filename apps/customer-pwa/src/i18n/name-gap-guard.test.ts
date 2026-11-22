import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { LanguageRoot, t } from "./i18n.js";
import { zhHans } from "./zh-Hans.js";

/**
 * Batch 46 (v15 overnight 45): one rule for a name or label filled into a Chinese sentence: no
 * space between it and the Chinese characters before or after it ("已选择在巷口糖水 Lane Dessert
 * (TEST)自取。", like "围炉火锅 Fireside Hotpot (TEST)只做堂食"). Live, the same kind of sentence had
 * three spacings, one of them a name joined to a translated piece with a space in code.
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

it("reads the live sentences with the Store's name joined directly", () => {
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
  expect(
    t("Pickup from {storeDisplayName} is selected.", {
      storeDisplayName: "巷口糖水 Lane Dessert (TEST)",
    }),
  ).toBe("已选择在巷口糖水 Lane Dessert (TEST)自取。");
  expect(
    t("{storeDisplayName} isn’t taking orders right now", {
      storeDisplayName: "半糖奶茶 Half Sugar Tea (TEST)",
    }),
  ).toBe("半糖奶茶 Half Sugar Tea (TEST)现在不接单");
  expect(t("{name} isn't available right now.", { name: "牛肉面" })).toBe("牛肉面现在不供应。");
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
