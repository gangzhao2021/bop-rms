import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { MenuListingReview } from "./MenuListingReview.js";

/** WP-2423 M72 (v15 2026-11-11 b10): "What goes live" names renamed dishes and new allergens. */
const sku = (n: number) => `018f2195-0000-7000-8000-${String(n).padStart(12, "0")}`;
const sesame = "018f2195-0000-7000-8000-0000000000a1";
const base = {
  priceDraft: null,
  priceChangesOnPricesPage: 0,
  pricePowers: undefined,
  choicePriceChanges: [],
  otherStores: null,
  latestRelease: { menuVersionReference: sku(90) },
  menu: { sections: [{ items: [{ skuReference: sku(1) }, { skuReference: sku(2) }] }] },
  allergenChoices: [
    { allergenReference: sesame, code: "SESAME", name: "Sesame seeds", nameZh: "芝麻" },
  ],
  sellables: [
    {
      skuReference: sku(1),
      productName: "Beef noodles",
      sizeName: "Beef noodles",
      allergens: {
        source: "StaffDeclared",
        declared: [{ allergenReference: sesame, classification: "CrossContactPossible" }],
        changedByRecipe: true,
      },
    },
    {
      skuReference: sku(2),
      productName: "Tea",
      sizeName: "Tea",
      allergens: { source: "None", declared: [] },
    },
  ],
  dishRenames: [
    { skuReference: sku(1), renamed: [{ locale: "zh-Hans-CA", from: "牛肉面", to: "红烧牛肉面" }] },
    { skuReference: sku(2), renamed: [{ locale: "en-CA", from: "Green tea", to: "Tea" }] },
  ],
};
const noop = () => undefined;
const render = (view: Record<string, unknown>) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <MenuListingReview
        view={view as never}
        undeclared={[]}
        busy={false}
        onList={noop}
        onRebase={noop}
        onShowUndeclared={noop}
        onBack={noop}
      />
    </MemoryRouter>,
  );
afterEach(() => setLanguageForTest("en"));

it("names each renamed dish and each dish whose allergens changed, beside the prices", () => {
  const html = render(base);
  expect(html).toContain("No price changes.");
  expect(html).toContain("Names and allergens");
  expect(html).toContain("Beef noodles: Chinese name 牛肉面 → 红烧牛肉面");
  expect(html).toContain("Renamed: Green tea → Tea");
  expect(html).toContain("Beef noodles: allergens changed · May contain Sesame seeds");
  expect(html).not.toContain("No name or allergen changes.");
  setLanguageForTest("zh-Hans");
  const zh = render(base);
  expect(zh).toContain("改名：牛肉面 → 红烧牛肉面");
  expect(zh).toContain("：英语名称 Green tea → Tea");
  expect(zh).toContain("过敏原有改动 · 可能含 芝麻");
});

it("says when nothing else changed, when it could not compare names, and nothing for a first listing", () => {
  const plain = {
    ...base,
    dishRenames: [],
    sellables: base.sellables.map((value) => ({
      ...value,
      allergens: { ...value.allergens, changedByRecipe: undefined },
    })),
  };
  expect(render(plain)).toContain("No name or allergen changes.");
  const unknown = render({ ...plain, dishRenames: null });
  expect(unknown).toContain(
    "Name changes could not be checked just now. The names go live as they are on this page.",
  );
  expect(unknown).not.toContain("No name or allergen changes.");
  expect(render({ ...plain, latestRelease: null })).not.toContain("Names and allergens");
});
