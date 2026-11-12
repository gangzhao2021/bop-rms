// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { setLanguageForTest } from "./i18n/i18n.js";
import { StoreOptionRecipesPage, declaredSummaryText } from "./StoreOptionRecipesPage.js";
import { mount, settle } from "./dom-test-kit.fixture.js";

afterEach(() => document.body.replaceChildren());

const standIn = "01a3ff00-0000-7000-8000-0000000000d1";
const view = (declaredItems: unknown) => ({
  screenId: "RECIPE-OPTION-LIST",
  sourceAsOf: "2026-11-10T12:00:00.000Z",
  permissions: { mayEdit: false, mayReview: false, mayPublish: false },
  soleOperator: null,
  ingredients: [],
  ...(declaredItems === undefined ? {} : { declaredItems }),
  options: [
    {
      productName: "Dan dan noodles",
      setName: "Spice level",
      optionName: "Mild",
      offered: true,
      bindingReference: "01a3ff00-0000-7000-8000-0000000000b1",
      optionReference: "01a3ff00-0000-7000-8000-0000000000c1",
      quantities: [1],
      sizes: [{ skuReference: "01a3ff00-0000-7000-8000-0000000000e1", name: "Dan dan noodles" }],
      covered: true,
      change: {
        changeVersionReference: "01a3ff00-0000-7000-8000-0000000000f1",
        version: 1,
        content: {
          kind: "Add",
          fromItemReference: null,
          toItemReference: standIn,
          quantity: "1",
          unitCostCents: null,
          lossPercent: "0",
        },
        byViewer: true,
        authorLabel: "You",
        recordedAt: "2026-11-10T11:00:00.000Z",
        published: true,
        reviews: [],
        lines: [
          {
            skuReference: "01a3ff00-0000-7000-8000-0000000000e1",
            quantity: 1,
            changes: [
              {
                fromItemReference: null,
                fromQuantityMicrounits: null,
                toItemReference: standIn,
                toQuantityMicrounits: "1000000",
              },
            ],
          },
        ],
      },
    },
  ],
});
const render = async (declaredItems: unknown) => {
  const { container } = await mount(
    <MemoryRouter>
      <StoreOptionRecipesPage client={{ load: async () => view(declaredItems) }} />
    </MemoryRouter>,
  );
  await settle();
  return container.textContent ?? "";
};

describe("WP-2423 (b9): a choice answered on the Menu page reads as a declaration on Option recipes", () => {
  it("says a choice answered Adds none adds no allergens, never one unit of an unnamed ingredient", async () => {
    const text = await render([
      { itemReference: standIn, declared: true, contains: [], mayContain: [] },
    ]);
    expect(text).toContain(
      "Adds no allergens (declared by staff on the Menu page; not a stock item)",
    );
    expect(text).not.toContain("per one chosen");
    expect(text).not.toContain("Dan dan noodles: ");
  });
  it("names what a choice adds, in English and Chinese", () => {
    expect(
      declaredSummaryText({ declared: true, contains: ["Mustard"], mayContain: ["Sesame"] }),
    ).toBe("Adds Mustard, may contain Sesame (declared by staff on the Menu page; not a stock item)");
    setLanguageForTest("zh-Hans");
    try {
      expect(declaredSummaryText({ declared: true, contains: [], mayContain: [] })).toBe(
        "不增加过敏原（员工在菜单页申报；不是库存品）",
      );
      expect(declaredSummaryText({ declared: true, contains: ["芥末"], mayContain: [] })).toBe(
        "增加 芥末（员工在菜单页申报；不是库存品）",
      );
    } finally {
      setLanguageForTest("en");
    }
  });
});
