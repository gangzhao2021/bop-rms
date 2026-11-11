import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { WasteDishesNote, wasteDishNames } from "./StoreWastePages.js";

describe("WP-2423 (M169): waste names the dishes it leaves short", () => {
  it("reads the dish names the record answered with, and nothing else", () => {
    expect(wasteDishNames([{ name: "Mapo tofu" }, { name: "" }, { other: 1 }, null])).toEqual([
      "Mapo tofu",
    ]);
    expect(wasteDishNames(undefined)).toEqual([]);
  });
  it("says which dishes use it and links to Item availability; says nothing for none", () => {
    const html = (dishes: readonly string[]) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <WasteDishesNote dishes={dishes} />
        </MemoryRouter>,
      );
    expect(html(["Mapo tofu", "Tofu soup"])).toContain(
      "Dishes that use what was thrown away: Mapo tofu, Tofu soup.",
    );
    expect(html(["Mapo tofu"])).toContain('href="/app/commerce/availability"');
    expect(html([])).toBe("");
    setLanguageForTest("zh-Hans");
    try {
      expect(html(["麻婆豆腐"])).toContain("用到报废品的菜：麻婆豆腐。");
    } finally {
      setLanguageForTest("en");
    }
  });
});
