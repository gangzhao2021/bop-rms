import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 9 (coordinator 2026-10-31 rule 1): at a Brand
 * with several Stores, Item availability shows each item's price at this Store, and the Store's
 * manager changes it there after confirming the old and the new price. A change built on a price
 * that has changed meanwhile is refused and the page shows the price now charged. With one Store
 * there is no price column. Synthetic items and prices.
 */
const id = (n: number) => "018f7731-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const store = {
  brandLabel: "Synthetic Brand",
  storeLabel: "DEMO Store 2 – not production",
  storeReference: id(98),
};
const soup = id(10);
test.use({ timezoneId: "America/Toronto" });

async function workspace(page: Page, multiStore: boolean) {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...store, timeZone: "America/Toronto" },
          authorizedStores: [store],
          businessDate: "2026-10-30",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "CAT-AVAILABILITY",
              label: "Item availability",
              href: "/app/commerce/availability",
              permission: "catalog.sku.read",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/commerce/availability/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-AVAILABILITY",
        sourceAsOf: "2026-10-31T16:00:00.000Z",
        viewer: id(5),
        timeZone: "America/Toronto",
        permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
        items: [
          {
            skuReference: soup,
            skuCode: "SOUP",
            productName: "Hot and sour soup (TEST)",
            sizeName: "Hot and sour soup (TEST)",
            status: "Available",
            soldOutUntil: null,
            stockSoldOut: null,
          },
        ],
      },
    }),
  );
  const prices = { brand: "650", own: null as string | null };
  const sent: unknown[] = [];
  await page.route("**/merchant/commerce/store-prices/query", (route) =>
    route.fulfill({
      headers,
      json: {
        sourceAsOf: "2026-10-31T16:00:00.000Z",
        multiStore,
        permissions: { mayChange: multiStore },
        currencyCode: "CAD",
        prices: [
          { sellableReference: soup, brandPriceMinor: prices.brand, storePriceMinor: prices.own },
        ],
        changes: [],
      },
    }),
  );
  return { prices, sent };
}

test("@production a Store's manager changes the price here, confirming old and new", async ({
  page,
}) => {
  const state = await workspace(page, true);
  await page.route("**/merchant/commerce/store-prices/command", async (route) => {
    const body = route.request().postDataJSON() as { expectedAmountMinor: string };
    state.sent.push(body);
    // The first try races another manager's change to 6.80; the second confirms 6.80 → 7.25.
    if (state.sent.length === 1) {
      state.prices.own = "680";
      return route.fulfill({ status: 409, headers, json: { error: "Changed" } });
    }
    state.prices.own = "725";
    return route.fulfill({ headers, json: { status: "Applied" } });
  });
  await page.goto("/app/commerce/availability");
  const row = page.getByRole("row", { name: /Hot and sour soup/u });
  await expect(page.getByRole("columnheader", { name: "Price here" })).toBeVisible();
  await expect(row).toContainText("$6.50");
  await row.getByRole("button", { name: /Change the price of Hot and sour soup/u }).click();
  await row.getByLabel(/New price for Hot and sour soup/u).fill("7.25");
  await row.getByRole("button", { name: "Continue" }).click();
  await expect(row).toContainText("from $6.50 to $7.25");
  await row.getByRole("button", { name: "Change price" }).click();
  // Changed meanwhile: refused, and the page now shows what the Store charges.
  await expect(row.getByRole("alert")).toContainText("The price changed since you opened");
  await expect(row).toContainText("$6.80");
  await row.getByRole("button", { name: /Change the price of Hot and sour soup/u }).click();
  await row.getByLabel(/New price for Hot and sour soup/u).fill("7.25");
  await row.getByRole("button", { name: "Continue" }).click();
  await expect(row).toContainText("from $6.80 to $7.25");
  await expectNoInternalText(page);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((v) => ["critical", "serious"].includes(v.impact ?? "")),
  ).toEqual([]);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.screenshot({
      path: `test-results/store-prices-confirm-${width}.png`,
      fullPage: true,
    });
  }
  await row.getByRole("button", { name: "Change price" }).click();
  await expect(page.getByText("now costs $7.25 at this Store")).toBeVisible();
  await expect(row).toContainText("This Store's price; Brand price $6.50");
  expect(state.sent).toEqual([
    expect.objectContaining({
      sellableReference: soup,
      expectedAmountMinor: "650",
      amountMinor: "725",
    }),
    expect.objectContaining({
      sellableReference: soup,
      expectedAmountMinor: "680",
      amountMinor: "725",
    }),
  ]);
});

test("@production with one Store there is no price column", async ({ page }) => {
  await workspace(page, false);
  await page.goto("/app/commerce/availability");
  await expect(page.getByRole("row", { name: /Hot and sour soup/u })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Price here" })).toHaveCount(0);
});
