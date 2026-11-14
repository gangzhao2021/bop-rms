import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
// Synthetic HTTP interception on the production PWA, not live Store evidence. Owner 2026-10-23:
// item names the Store writes (cart, order status) follow the guest's language. The routes answer
// as the server does: Chinese names when `locale=zh-Hans-CA` is asked, and an item without a
// Chinese name keeps its English name.
const id = (n: number) => "018f8a10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "e".repeat(43);
const chinese = (url: string) => new URL(url).searchParams.get("locale") === "zh-Hans-CA";
const names = (url: string) =>
  chinese(url) ? { latte: "拿铁", bagel: "Plain bagel" } : { latte: "Latte", bagel: "Plain bagel" };

async function enter(page: Page) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Language Store",
        publicStoreReference: id(6),
        publicTableReference: null,
        channel: "Pickup",
        operatingState: "Open",
        availableServiceModes: ["Pickup"],
        locale: "en-CA",
        contextExpiresAt: expiresAt,
        csrfToken: csrf,
      },
    }),
  );
  return expiresAt;
}
const navigate = (page: Page, path: string) =>
  page.evaluate((path) => {
    history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);

test.describe("@production customer item names in the chosen language", () => {
  test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

  test("the cart reads its items again in Chinese after the switch", async ({ page }) => {
    const expiresAt = await enter(page);
    const asked: string[] = [];
    await page.route("**/bff/customer/cart**", (route) => {
      const url = route.request().url();
      asked.push(new URL(url).search);
      const name = names(url);
      const line = (reference: number, displayName: string) => ({
        cartItemReference: id(reference),
        sellableReference: id(reference + 1),
        displayName,
        quantity: 1,
        configuration: [],
        customerNote: null,
        lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
        warnings: [],
      });
      return route.fulfill({
        status: 200,
        json: {
          schemaVersion: 1,
          cart: {
            cartReference: id(1),
            version: 2,
            orderType: "Pickup",
            serviceMode: "Pickup",
            context: { brandName: "Synthetic Brand", storeName: "Synthetic Language Store" },
            lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
            items: [line(2, name.latte), line(4, name.bagel)],
            quote: null,
            warnings: [],
          },
        },
      });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Language Store", exact: true }),
    ).toBeVisible();
    await navigate(page, "/cart");
    await expect(page.getByRole("heading", { name: "Latte", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(page.getByRole("heading", { name: "拿铁", exact: true })).toBeVisible();
    // No Chinese name: the English name, never an empty line.
    await expect(page.getByRole("heading", { name: "Plain bagel", exact: true })).toBeVisible();
    expect(asked).toContain("?locale=zh-Hans-CA");
    await page.getByRole("button", { name: "Switch to English" }).click();
    await expect(page.getByRole("heading", { name: "Latte", exact: true })).toBeVisible();
    expect(asked.at(-1)).toBe("");
    await expectNoInternalText(page);
  });

  test("the order status reads its items again in Chinese after the switch", async ({ page }) => {
    await enter(page);
    const asked: string[] = [];
    await page.route("**/api/v1/orders/*/status**", (route) => {
      const url = route.request().url();
      asked.push(new URL(url).search);
      const name = names(url);
      const item = (reference: number, displayName: string, amountMinor: string) => ({
        orderItemReference: id(reference),
        displayName,
        quantity: 1,
        lineTotal: { amountMinor, currencyCode: "CAD" },
      });
      return route.fulfill({
        json: {
          schemaVersion: 1,
          status: {
            projectionName: "ordering_order_status_v1",
            projectionVersion: 1,
            sourceCheckpoint: id(8),
            projectedAt: "2026-10-23T14:00:00.000Z",
            freshnessStatus: "Fresh",
            order: {
              orderReference: id(1),
              orderNumber: "1001",
              orderType: "Pickup",
              canonicalPhase: "Submitted",
              paymentStatus: "NotReported",
              kitchenStatus: "Unavailable",
              fulfillmentStatus: "Unavailable",
              fulfilledAt: null,
              eta: null,
              submittedAt: "2026-10-23T13:55:00.000Z",
              batches: [
                {
                  orderBatchReference: id(3),
                  submittedAt: "2026-10-23T13:55:00.000Z",
                  items: [item(4, name.latte, "565"), item(5, name.bagel, "339")],
                },
              ],
            },
            sources: {
              checkedAt: "2026-10-23T14:00:00.000Z",
              kitchen: {
                batches: [
                  {
                    orderBatchReference: id(3),
                    status: "InProgress",
                    updatedAt: "2026-10-23T13:59:00.000Z",
                  },
                ],
              },
              payments: [
                {
                  status: "Succeeded",
                  occurredAt: "2026-10-23T13:56:00.000Z",
                  amount: { amountMinor: "904", currencyCode: "CAD" },
                  freshnessStatus: "Fresh",
                },
              ],
            },
          },
        },
      });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Language Store", exact: true }),
    ).toBeVisible();
    await navigate(page, "/orders/" + id(1));
    const line = (name: string) => page.getByRole("listitem").filter({ hasText: name });
    await expect(line("Latte")).toBeVisible();
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(line("拿铁")).toBeVisible();
    // No Chinese name: the English name, never an empty line.
    await expect(line("Plain bagel")).toBeVisible();
    await expect(line("Latte")).toHaveCount(0);
    expect(asked).toContain("?locale=zh-Hans-CA");
    await expectNoInternalText(page);
  });
});
