import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 (b11 guest-and-staff-wording), 1440, 1024 and 390 wide. Synthetic, TEST-only data.
 * 1. Option recipes: a choice listed from the Menu page at a one-Store Brand reads as approved by
 *    that one person under that rule (never as breaking the two-reviewer rule the page states), and
 *    it is changed on the Menu page, never in the stock-recipe form.
 * 2. Opening count: the posted count at 390 names each value's column (location, lot code, expiry,
 *    quantity, unit cost), in English and in Chinese, and its expiry reads as a date.
 */
const id = (n: number) => "0190996b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const at = "2026-11-12T15:05:00.000Z";
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
async function session(page: Page, screenId: string, href: string, permission: string) {
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
          businessDate: "2026-11-12",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [{ screenId, label: "Screen", href, permission }],
        },
      },
    }),
  );
}
const widths = [1440, 1024, 390];
async function eachWidth(page: Page, name: string, check: () => Promise<void>) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await check();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/b11-" + name + "-" + String(width) + ".png",
      fullPage: true,
    });
  }
}

const review = (kind: "Cost" | "FoodSafety") => ({
  kind,
  decision: "Approved",
  byViewer: true,
  reviewerLabel: "You",
  comment: null,
  reviewedAt: at,
  mode: "SingleStoreListing",
});
const answered = (n: number, optionName: string) => ({
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
      toItemReference: id(70),
      quantity: "1",
      unitCostCents: null,
      lossPercent: "0",
    },
    byViewer: true,
    authorLabel: "You",
    recordedAt: at,
    published: true,
    reviews: [review("Cost"), review("FoodSafety")],
    lines: [
      {
        skuReference: id(44),
        quantity: 1,
        changes: [
          {
            fromItemReference: null,
            fromQuantityMicrounits: null,
            toItemReference: id(70),
            toQuantityMicrounits: "1000000",
          },
        ],
      },
    ],
  },
});

test("@production b11: a Menu-page choice says who approved it alone and why, has its allergens changed on the Menu page and can be tracked as stock", async ({
  page,
}) => {
  await session(page, "RECIPE-OPTION-LIST", "/app/commerce/option-recipes", "recipe.read");
  await page.route("**/merchant/commerce/option-recipes/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "RECIPE-OPTION-LIST",
        sourceAsOf: at,
        permissions: { mayEdit: true, mayReview: true, mayPublish: true },
        soleOperator: null,
        ingredients: [],
        declaredItems: [{ itemReference: id(70), declared: true, contains: [], mayContain: [] }],
        options: [answered(60, "Mild")],
      },
    }),
  );
  await page.goto("/app/commerce/option-recipes");
  const mild = page.getByRole("row", { name: /Mild/u });
  await eachWidth(page, "option-recipes", async () => {
    await expect(mild).toBeVisible();
    await expect(mild).toContainText("Cost: approved by You on");
    await expect(
      mild.getByText(
        /given alone when listing from the Menu page \(the Brand had one Store then\)/u,
      ),
    ).toHaveCount(2);
    await expect(
      mild.getByRole("link", { name: "Change allergens on the Menu page" }),
    ).toHaveAttribute("href", "/app/commerce/menus");
    // The declaration is not edited as stock; a kitchen that starts counting it can track it.
    await expect(mild.getByRole("button", { name: "Change", exact: true })).toHaveCount(0);
    await expect(mild.getByRole("button", { name: "Track stock for this choice" })).toBeVisible();
  });
  await mild.getByRole("button", { name: "Track stock for this choice" }).click();
  await expect(
    page.getByText(/Saving replaces the allergens answered on the Menu page for this choice/u),
  ).toBeVisible();
  await expect(page.getByText(/approved by that one person; their reviews say so/u)).toBeVisible();
  await expectNoInternalText(page);
});

for (const language of ["en", "zh-Hans"] as const)
  test(`@production b11: the posted opening count names every value's column at each width (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    if (zh)
      await page.addInitScript(() => {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      });
    await session(page, "INV-OPENING-COUNT", "/app/supply/opening-count", "inventory.count.read");
    const posted = id(80);
    await page.route("**/merchant/supply/opening-count/query", (route) =>
      route.fulfill({
        headers,
        json: {
          screenId: "INV-OPENING-COUNT",
          sourceAsOf: at,
          permissions: { mayCount: true, mayPost: true },
          postedCountReference: posted,
          counts: [
            {
              countReference: posted,
              lifecycle: "Posted",
              version: 4,
              lineCount: 1,
              updatedAt: at,
              submittedBySelf: false,
            },
          ],
          selected: {
            countReference: posted,
            lifecycle: "Posted",
            version: 4,
            lines: [
              {
                lineReference: id(81),
                itemReference: id(82),
                locationReference: id(83),
                lotCode: "L2410A",
                expiryDate: "2026-10-20",
                quantity: "8",
                unitCostMinor: 289,
              },
            ],
          },
          items: [
            {
              itemReference: id(82),
              internalCode: "MILK-325",
              name: "Whole milk 3.25% (TEST)",
              unitCode: "L",
              ledgerPrecision: 3,
              lotTracking: "LotExpiryRequired",
            },
          ],
          locations: [{ locationReference: id(83), code: "FRZ-A", name: "Chest freezer A" }],
        },
      }),
    );
    await page.goto("/app/supply/opening-count/" + posted);
    const row = page.getByRole("row", { name: /Whole milk/u });
    const labels = zh
      ? ["库位", "批号", "效期", "数量", "单位成本"]
      : ["Location", "Lot code", "Expiry", "Quantity", "Unit cost ($)"];
    await eachWidth(page, "opening-count-" + language, async () => {
      await expect(row).toBeVisible();
      // The expiry reads as a date staff read, never 2026-10-20.
      for (const value of [
        "Chest freezer A",
        "L2410A",
        zh ? "2026年10月20日" : "Oct 20, 2026",
        "2.89",
      ])
        await expect(row).toContainText(value);
      const narrow = (page.viewportSize()?.width ?? 0) < 640;
      // Each value cell names its column: shown before the value where the header row is hidden.
      const named = await row.evaluate((element) =>
        [...element.querySelectorAll("td[data-label]")].map((cell) => ({
          label: cell.getAttribute("data-label"),
          shown: getComputedStyle(cell, "::before").content,
        })),
      );
      expect(named.map((cell) => cell.label)).toEqual(
        labels.map((label) => expect.stringContaining(label)),
      );
      for (const cell of named) expect(cell.shown.includes(cell.label ?? "?")).toBe(narrow);
    });
    await expectNoInternalText(page);
  });
