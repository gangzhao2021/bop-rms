// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { setLanguageForTest } from "./i18n/i18n.js";
import {
  StoreOptionRecipesPage,
  aloneReviewText,
  declaredSummaryText,
} from "./StoreOptionRecipesPage.js";
import { click, mount, settle } from "./dom-test-kit.fixture.js";

afterEach(() => document.body.replaceChildren());

const standIn = "01a3ff00-0000-7000-8000-0000000000d1";
const view = (
  declaredItems: unknown,
  extra: { mayEdit?: boolean; reviews?: unknown[]; toItemReference?: string } = {},
) => ({
  screenId: "RECIPE-OPTION-LIST",
  sourceAsOf: "2026-11-10T12:00:00.000Z",
  permissions: { mayEdit: extra.mayEdit ?? false, mayReview: false, mayPublish: false },
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
          toItemReference: extra.toItemReference ?? standIn,
          quantity: "1",
          unitCostCents: null,
          lossPercent: "0",
        },
        byViewer: true,
        authorLabel: "You",
        recordedAt: "2026-11-10T11:00:00.000Z",
        published: true,
        reviews: extra.reviews ?? [],
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
const mountPage = async (declaredItems: unknown, extra: Parameters<typeof view>[1] = {}) => {
  const { container } = await mount(
    <MemoryRouter>
      <StoreOptionRecipesPage client={{ load: async () => view(declaredItems, extra) }} />
    </MemoryRouter>,
  );
  await settle();
  return container;
};
const render = async (declaredItems: unknown) => (await mountPage(declaredItems)).textContent ?? "";

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
    ).toBe(
      "Adds Mustard, may contain Sesame (declared by staff on the Menu page; not a stock item)",
    );
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

describe("WP-2423 (b11): a review one person gave alone says under which rule", () => {
  const review = (kind: "Cost" | "FoodSafety", mode?: string) => ({
    kind,
    decision: "Approved",
    byViewer: true,
    reviewerLabel: "You",
    comment: null,
    reviewedAt: "2026-11-10T11:00:00.000Z",
    ...(mode === undefined ? {} : { mode }),
  });
  const declared = [{ itemReference: standIn, declared: true, contains: [], mayContain: [] }];
  it("a Menu-page listing at a one-Store Brand reads as approved alone under that rule", async () => {
    const text =
      (
        await mountPage(declared, {
          reviews: [
            review("Cost", "SingleStoreListing"),
            review("FoodSafety", "SingleStoreListing"),
          ],
        })
      ).textContent ?? "";
    expect(
      text.match(/given alone when listing from the Menu page \(the Brand had one Store then\)/gu),
    ).toHaveLength(2);
    expect(text).toContain("approved by that one person; their reviews say so");
  });
  it("names the sole operator and the Brand owner, and says nothing extra for another reviewer", async () => {
    const text =
      (
        await mountPage(declared, {
          reviews: [review("Cost", "SoleOperator"), review("FoodSafety", "BrandOwnerListing")],
        })
      ).textContent ?? "";
    expect(text).toContain("given alone as sole operator");
    expect(text).toContain("given alone by the Brand's owner when listing from the Menu page");
    const independent =
      (
        await mountPage(declared, {
          reviews: [review("Cost", "Independent"), review("FoodSafety")],
        })
      ).textContent ?? "";
    expect(independent).not.toContain("given alone");
  });
  it("a declaration's allergens are changed on the Menu page, and staff who edit can track it as stock", async () => {
    const container = await mountPage(declared, { mayEdit: true });
    const link = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Change allergens on the Menu page",
    );
    expect(link?.getAttribute("href")).toBe("/app/commerce/menus");
    const buttons = () => [...container.querySelectorAll("button")];
    expect(buttons().some((button) => button.textContent === "Change")).toBe(false);
    // A kitchen that starts counting the add-on turns it into a stock recipe here.
    const track = buttons().find((button) => button.textContent === "Track stock for this choice");
    expect(track).toBeDefined();
    await click(track);
    await settle();
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.textContent).toContain(
      "Saving replaces the allergens answered on the Menu page for this choice",
    );
    // It starts as a stock add with no ingredient chosen (the stand-in is not an ingredient).
    expect(container.querySelector<HTMLSelectElement>("form select")?.value).toBe("Add");
    // A stock change keeps its own editor, and no Menu-page link.
    const stock = await mountPage(declared, {
      mayEdit: true,
      toItemReference: "01a3ff00-0000-7000-8000-0000000000d9",
    });
    expect(
      [...stock.querySelectorAll("button")].some((button) => button.textContent === "Change"),
    ).toBe(true);
    expect(stock.textContent).not.toContain("Change allergens on the Menu page");
  });
  it("staff who cannot edit are shown no change action for a declaration", async () => {
    const container = await mountPage(declared, { mayEdit: false });
    expect(container.textContent).not.toContain("Change allergens on the Menu page");
    expect(container.textContent).not.toContain("Track stock for this choice");
    expect(container.textContent).toContain("declared by staff on the Menu page");
  });
  it("says it in Chinese", async () => {
    setLanguageForTest("zh-Hans");
    try {
      const text =
        (
          await mountPage(declared, {
            mayEdit: true,
            reviews: [
              review("Cost", "SingleStoreListing"),
              review("FoodSafety", "SingleStoreListing"),
            ],
          })
        ).textContent ?? "";
      expect(text).toContain("从菜单页上架时单独审核（当时品牌只有一家门店）");
      expect(text).toContain("在菜单页修改过敏原");
      expect(text).toContain("按库存记录此选项");
      expect(text).toContain("由这一个人批准，审核记录会注明");
      expect(aloneReviewText("SoleOperator")).toBe("以唯一操作人身份单独审核");
      expect(aloneReviewText("BrandOwnerListing")).toBe("品牌老板从菜单页上架时单独审核");
    } finally {
      setLanguageForTest("en");
    }
  });
});
