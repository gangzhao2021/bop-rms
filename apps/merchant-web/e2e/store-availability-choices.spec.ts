import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 sold-out-and-allergen-safety (M24, M78): a manager marks pearls sold out once for every
 * drink at the Store and brings them back; a dish short of stock reads sold out to guests; a stock
 * read that failed is said, never shown as "Available". Synthetic route mocks only.
 */
const id = (n: number) => "01909a1f-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
const headers = { "cache-control": "no-store" };

async function session(page: Page) {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-10-14",
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
}

async function availability(page: Page, stockCheck: "Checked" | "NotChecked") {
  let pearls = { status: "Available", soldOutUntil: null as string | null };
  const commands: Record<string, unknown>[] = [];
  const item = (n: number, product: string, extra: Record<string, unknown>) => ({
    skuReference: id(n),
    skuCode: "SKU-" + n,
    productName: product,
    sizeName: product,
    status: "Available",
    soldOutUntil: null,
    decidedHere: true,
    stockSoldOut: null,
    stock: "Enough",
    ...extra,
  });
  await page.route("**/merchant/commerce/availability/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-AVAILABILITY",
        sourceAsOf: "2026-10-14T18:00:00.000Z",
        viewer: id(50),
        timeZone: "America/Toronto",
        permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
        stockCheck,
        items: [
          item(1, "Milk tea", {}),
          item(2, "Mapo tofu", {
            stock: "Short",
            stockSoldOut: {
              ingredients: [
                {
                  name: "Soft tofu",
                  unitCode: "KG",
                  displayPrecision: 3,
                  required: "0.3",
                  onHand: "0",
                  reserved: "0",
                  available: "0",
                  openOrderCount: 0,
                },
              ],
            },
          }),
        ].map((entry) =>
          stockCheck === "NotChecked" ? { ...entry, stock: "Unknown", stockSoldOut: null } : entry,
        ),
        options: [
          {
            optionReference: id(30),
            name: "Pearls",
            dishNames: ["Brown sugar milk", "Jasmine milk tea", "Milk tea", "Taro milk tea"],
            ...pearls,
          },
          {
            optionReference: id(31),
            name: "Coconut jelly",
            dishNames: ["Milk tea"],
            status: "Available",
            soldOutUntil: null,
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/commerce/availability/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    pearls =
      body.action === "OptionSoldOut"
        ? { status: "SoldOut", soldOutUntil: "2026-10-15T08:00:00.000Z" }
        : { status: "Available", soldOutUntil: null };
    return route.fulfill({ headers, json: { status: "Applied", option: pearls } });
  });
  return commands;
}

test("@production A manager marks pearls sold out in every drink at once and brings them back", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-14T22:00:00.000Z"));
  await session(page);
  const commands = await availability(page, "Checked");
  await page.goto("/app/commerce/availability");
  await expect(page.getByRole("heading", { name: "Extras and choices" })).toBeVisible();
  // M78: a dish short of stock reads sold out to guests, with the ingredient and the way back.
  const tofu = page.getByRole("row", { name: /Mapo tofu/u });
  await expect(tofu).toContainText("Sold out to guests (stock)");
  await expect(tofu).toContainText("No Soft tofu is in stock.");
  await expect(tofu.getByRole("link", { name: "Record a delivery" })).toBeVisible();
  await expect(page.getByText("Stock couldn't be checked just now")).toHaveCount(0);
  // The choices list filters as staff type, by choice or by dish.
  const pearlsRow = page.getByRole("row", { name: /Pearls/u });
  await expect(pearlsRow).toContainText("In: Brown sugar milk, Jasmine milk tea, Milk tea +1");
  await page.getByLabel("Find a choice").fill("coco");
  await expect(page.getByRole("row", { name: /Pearls/u })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Coconut jelly/u })).toBeVisible();
  await page.getByLabel("Find a choice").fill("taro");
  await expect(pearlsRow).toBeVisible();
  await page.getByLabel("Find a choice").fill("");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(pearlsRow).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/availability-choices-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);
  await expectNoInternalText(page);

  await pearlsRow.getByRole("button", { name: "Sold out today" }).click();
  await expect(page.getByText("Pearls is sold out for today in every dish.")).toBeVisible();
  await expect(pearlsRow).toContainText("Sold out until 4:00 AM tomorrow");
  expect(commands[0]).toMatchObject({
    action: "OptionSoldOut",
    optionReference: id(30),
    until: "EndOfDay",
  });
  await pearlsRow.getByRole("button", { name: "Back on" }).click();
  await expect(page.getByText("Pearls is back on.")).toBeVisible();
  expect(commands[1]).toMatchObject({ action: "OptionBackOn", optionReference: id(30) });
  await expect(pearlsRow.getByRole("button", { name: "Sold out today" })).toBeVisible();
});

test("@production A stock read that failed is said, and no dish is shown as Available", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-14T22:00:00.000Z"));
  await session(page);
  await availability(page, "NotChecked");
  await page.goto("/app/commerce/availability");
  await expect(
    page.getByText(
      "Stock couldn't be checked just now, so items short of stock aren't marked. Refresh to try again.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /Milk tea/u }).first()).toContainText("Offered");
  await expect(page.getByRole("row", { name: /Mapo tofu/u })).not.toContainText("Available");
  await page.screenshot({
    path: "test-results/availability-stock-unread-1440.png",
    fullPage: true,
  });
});
