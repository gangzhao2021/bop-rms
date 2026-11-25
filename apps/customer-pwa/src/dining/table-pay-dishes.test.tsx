import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import { onlyMineText, splitPartDishesText } from "./TablePayPanel.js";

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

// Batch 50: a guest whose own dishes are unpaid but can't be priced on this read read "nothing of
// yours is left to pay" / 没有您要付的菜, which is false.
it('says truthfully why "only what I added" is off, in English and zh-Hans', () => {
  const text = (
    language: "en" | "zh-Hans",
    addedAny: boolean | null,
    mineUnavailable: boolean | null,
  ) =>
    renderToStaticMarkup(
      <LanguageRoot initial={language}>
        {() => <p>{onlyMineText({ mine: null, addedAny, mineUnavailable })}</p>}
      </LanguageRoot>,
    );
  expect(text("en", true, true)).toBe(
    "<p>Only what I added (can’t be worked out right now — please ask staff)</p>",
  );
  expect(text("zh-Hans", true, true)).toBe("<p>只付我加的（暂时算不出来，请找店员）</p>");
  expect(text("en", true, false)).toBe(
    "<p>Only what I added (nothing of yours is left to pay)</p>",
  );
  expect(text("zh-Hans", true, false)).toBe("<p>只付我加的（没有您要付的菜）</p>");
  expect(text("zh-Hans", false, null)).toBe("<p>只付我加的（账单上没有您加的菜）</p>");
  // An older server says neither: as before.
  expect(text("zh-Hans", null, null)).toBe("<p>只付我加的（没有您要付的菜）</p>");
});

// Batch 63 (v15 batch 62 review D62B-14, F13): "Only what I added (1 · $14.13)" left out what the
// "1" counts in English (zh said 道).
it('says what "only what I added" counts: 1 dish · $14.13', () => {
  const text = (language: "en" | "zh-Hans", count: number) =>
    renderToStaticMarkup(
      <LanguageRoot initial={language}>
        {() => (
          <p>
            {onlyMineText({
              mine: { count, amountMinor: "1413" },
              addedAny: true,
              mineUnavailable: false,
            })}
          </p>
        )}
      </LanguageRoot>,
    );
  expect(text("en", 1)).toBe("<p>Only what I added (1 dish · $14.13)</p>");
  expect(text("en", 3)).toBe("<p>Only what I added (3 dishes · $14.13)</p>");
  expect(text("zh-Hans", 3)).toBe("<p>只付我加的（3 道 · $14.13）</p>");
});
