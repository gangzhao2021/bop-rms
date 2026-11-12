import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 (b9, sold-out-allergens): a choice answered on the Menu page ("Adds none", or the
 * allergens it adds) reads on Option recipes as what staff declared for it, never as one unit of
 * an unnamed ingredient. 1440, 1024 and 390 wide. Synthetic, TEST-only data.
 */
const id = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const at = "2026-11-10T15:05:00.000Z";
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const answered = (n: number, optionName: string, standIn: number) => ({
  productName: "Dan dan noodles (TEST)",
  setName: "Spice level",
  optionName,
  offered: true,
  bindingReference: id(52),
  optionReference: id(n),
  quantities: [1],
  sizes: [{ skuReference: id(44), name: "Dan dan noodles (TEST)" }],
  covered: true,
  change: {
    changeVersionReference: id(n + 100),
    version: 1,
    content: {
      kind: "Add",
      fromItemReference: null,
      toItemReference: id(standIn),
      quantity: "1",
      unitCostCents: null,
      lossPercent: "0",
    },
    byViewer: true,
    authorLabel: "You",
    recordedAt: at,
    published: true,
    reviews: [],
    lines: [
      {
        skuReference: id(44),
        quantity: 1,
        changes: [
          {
            fromItemReference: null,
            fromQuantityMicrounits: null,
            toItemReference: id(standIn),
            toQuantityMicrounits: "1000000",
          },
        ],
      },
    ],
  },
});

test("@production b9: Option recipes says what a choice answered on the Menu page adds, never one unit of stock", async ({
  page,
}) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-10",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "RECIPE-OPTION-LIST",
              label: "Option recipes",
              href: "/app/commerce/option-recipes",
              permission: "recipe.read",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/commerce/option-recipes/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "RECIPE-OPTION-LIST",
        sourceAsOf: at,
        permissions: { mayEdit: false, mayReview: false, mayPublish: false },
        soleOperator: null,
        ingredients: [],
        declaredItems: [
          { itemReference: id(70), declared: true, contains: [], mayContain: [] },
          { itemReference: id(71), declared: true, contains: ["Mustard"], mayContain: [] },
        ],
        options: [answered(60, "Mild", 70), answered(61, "Extra hot", 71)],
      },
    }),
  );
  await page.goto("/app/commerce/option-recipes");
  const mild = page.getByRole("row", { name: /Mild/u });
  await expect(mild).toContainText(
    "Adds no allergens (declared by staff on the Menu page; not a stock item)",
  );
  await expect(page.getByRole("row", { name: /Extra hot/u })).toContainText(
    "Adds Mustard (declared by staff on the Menu page; not a stock item)",
  );
  await expect(page.getByText("per one chosen")).toHaveCount(0);
  await expect(page.getByText("Dan dan noodles (TEST): 1")).toHaveCount(0);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(mild).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/b9-option-recipes-" + String(width) + ".png",
      fullPage: true,
    });
  }
  await expectNoInternalText(page);
});
