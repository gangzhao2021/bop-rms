import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
// Synthetic HTTP interception on the production PWA, not live Store or Catalog evidence.
// b7 (sold-out-allergens, M154): staff mark Lemon tea "Sold out today" while it is in the guest's
// cart. Its line says so and offers only Remove (no "+" or "−"); a "+" on another dish that sold
// out a moment ago says "This dish just sold out." as the headline, never "can't be ordered as
// selected".
const id = (n: number) => "018f8904-0000-7000-8000-" + n.toString(16).padStart(12, "0");

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet", width: 1024, height: 768, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Cart sold out " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("a sold-out line offers only Remove, and a refused + says the dish just sold out", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      await page.route("**/bff/customer/entry", (route) =>
        route.fulfill({
          status: 201,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 2,
            status: "Established",
            brandDisplayName: "Synthetic Brand",
            storeDisplayName: "Synthetic Tea Store",
            publicStoreReference: id(4),
            publicTableReference: null,
            channel: "Pickup",
            operatingState: "Open",
            availableServiceModes: ["Pickup"],
            locale: "en-CA",
            contextExpiresAt: expiresAt,
            csrfToken: "d".repeat(43),
          },
        }),
      );
      const line = (reference: number, name: string, warnings: string[]) => ({
        cartItemReference: id(reference),
        sellableReference: id(reference + 1),
        displayName: name,
        quantity: 2,
        configuration: [],
        customerNote: null,
        lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
        warnings,
      });
      const cart = {
        cartReference: id(1),
        version: 3,
        orderType: "Pickup",
        serviceMode: "Pickup",
        context: { brandName: "Synthetic Brand", storeName: "Synthetic Tea Store" },
        lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
        items: [
          line(2, "Synthetic lemon tea", ["ITEM_UNAVAILABLE"]),
          line(6, "Synthetic milk tea", []),
        ],
        quote: null,
        warnings: [],
      };
      await page.route("**/bff/customer/cart**", (route) =>
        route.fulfill({ status: 200, json: { schemaVersion: 1, cart } }),
      );
      const writes: string[] = [];
      await page.route("**/api/v1/carts/*/items/*", (route) => {
        writes.push(route.request().method() + " " + route.request().url().split("/items/")[1]);
        // Milk tea sold out a moment ago, before the cart showed it.
        return route.fulfill({
          status: 422,
          json: {
            schemaVersion: 1,
            error: {
              code: "cart_selection_invalid",
              messageKey: "customer.cart.selection_invalid",
              issueCodes: ["CATALOG_ITEM_SOLD_OUT"],
            },
          },
        });
      });
      const press = async (locator: ReturnType<typeof page.getByRole>) => {
        if (screen.touch) await locator.tap();
        else await locator.click();
      };
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(
        page.getByRole("heading", { name: "Synthetic Tea Store", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        history.pushState(null, "", "/cart");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      const lemon = page.locator(`article[aria-labelledby="cart-item-${id(2)}"]`);
      await expect(
        lemon.getByText("Not available right now. Remove it to order the rest."),
      ).toBeVisible();
      await expect(
        lemon.getByRole("button", { name: "Increase Synthetic lemon tea quantity" }),
      ).toBeDisabled();
      await expect(
        lemon.getByRole("button", { name: "Decrease Synthetic lemon tea quantity" }),
      ).toBeDisabled();
      await expect(lemon.getByRole("button", { name: "Remove" })).toBeEnabled();
      await page.screenshot({
        path: `test-results/cart-sold-out-line-${screen.width}.png`,
        fullPage: true,
      });
      await press(page.getByRole("button", { name: "Increase Synthetic milk tea quantity" }));
      await expect(page.getByRole("heading", { name: "This dish just sold out." })).toBeVisible();
      await expect(page.getByText(/can’t be ordered as selected/u)).toHaveCount(0);
      await expect(page.getByText("Review this item", { exact: true })).toHaveCount(0);
      expect(writes).toEqual(["PATCH " + id(6)]);
      await page.screenshot({
        path: `test-results/cart-sold-out-refused-${screen.width}.png`,
        fullPage: true,
      });
      await expectNoInternalText(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(failures).toEqual([]);
    });
  });
}
