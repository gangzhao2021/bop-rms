import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import { splitPartDishesText } from "./TablePayPanel.js";

// Batch 42 (v15 TM2 zh-Hans): a by-dish part listed its dishes as "牛肉面, 豆浆", with an English
// comma; Chinese lists names with 、, as the Orders rows do. English keeps its comma.
it("lists a split part's dishes with 、 in zh-Hans and a comma in English", () => {
  const dishes = [
    { displayName: "牛肉面", quantity: 1, shared: false },
    { displayName: "豆浆", quantity: 2, shared: true },
  ];
  const text = (language: "en" | "zh-Hans", markShared: boolean) =>
    renderToStaticMarkup(
      <LanguageRoot initial={language}>
        {() => <p>{splitPartDishesText(dishes, markShared)}</p>}
      </LanguageRoot>,
    );
  expect(text("zh-Hans", false)).toBe("<p>牛肉面、2 × 豆浆</p>");
  expect(text("en", false)).toBe("<p>牛肉面, 2 × 豆浆</p>");
  expect(text("en", true)).toBe("<p>牛肉面, 2 × 豆浆 (shared)</p>");
});
