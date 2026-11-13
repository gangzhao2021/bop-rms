import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
// Synthetic HTTP interception on the production PWA, not live Store or payment evidence.
// WP-2423 (reads-under-burst, v15 2026-11-13): right after joining a pay-first table, the guest's
// first checkout read its cart while the store was busy. The page sat on "Getting your total…",
// then showed only a disabled "Continue to payment": no order, no total, no word of what happened.
// Now it says the store is busy, reads the cart again by itself when the store said, and offers
// Try again; then the order and its total show as usual.
const id = (n: number) => "018f8903-0000-7000-8000-" + n.toString(16).padStart(12, "0");

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet", width: 1024, height: 768, touch: true },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Checkout when the cart read is busy " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("says the store is busy, reads the cart again by itself and then shows the total", async ({
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
            storeDisplayName: "Synthetic Busy Store",
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
      // Busy for the cart reads of the checkout's first 2.5 s, past the app's own quiet re-reads
      // (the store's answer: 503 + Retry-After 2), as in the rush right after joining.
      let busyUntil = 0;
      let busyAnswers = 0;
      await page.route("**/bff/customer/cart**", (route) => {
        if (Date.now() < busyUntil && route.request().method() === "GET") {
          busyAnswers += 1;
          return route.fulfill({
            status: 503,
            headers: { "retry-after": "2", "cache-control": "no-store" },
            json: { schemaVersion: 1, error: { code: "service_busy" }, code: "SERVICE_BUSY" },
          });
        }
        return route.fulfill({
          status: 200,
          json: {
            schemaVersion: 1,
            cart: {
              cartReference: id(1),
              version: 3,
              orderType: "Pickup",
              serviceMode: "Pickup",
              context: { brandName: "Synthetic Brand", storeName: "Synthetic Busy Store" },
              lifecycle: {
                status: "Active",
                idleExpiresAt: expiresAt,
                absoluteExpiresAt: expiresAt,
              },
              items: [
                {
                  cartItemReference: id(2),
                  sellableReference: id(3),
                  displayName: "Synthetic noodles",
                  quantity: 1,
                  configuration: [],
                  customerNote: null,
                  lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
                  warnings: [],
                },
              ],
              quote: null,
              warnings: [],
            },
          },
        });
      });
      await page.route("**/api/v1/carts/*/quote", (route) =>
        route.fulfill({
          status: 201,
          json: {
            schemaVersion: 1,
            quote: {
              quoteReference: id(5),
              quoteVersion: 1,
              cartVersion: 3,
              currency: "CAD",
              subtotal: { amountMinor: "250", currency: "CAD" },
              discount: { amountMinor: "0", currency: "CAD" },
              tax: { amountMinor: "33", currency: "CAD" },
              fee: { amountMinor: "0", currency: "CAD" },
              total: { amountMinor: "283", currency: "CAD" },
              expiresAt,
              warnings: [],
              blockingReasons: [],
              priceChange: null,
            },
          },
        }),
      );
      await page.route("**/bff/customer/checkout-details/current", (route) =>
        route.fulfill({
          json: {
            schemaVersion: 1,
            checkout: { cartReference: id(1), cartVersion: 3, orderType: "Pickup", details: null },
          },
        }),
      );
      await page.route("**/bff/customer/checkout-details/policy", (route) =>
        route.fulfill({
          json: {
            schemaVersion: 1,
            policy: {
              cartReference: id(1),
              cartVersion: 3,
              orderType: "Pickup",
              checkedAt: new Date(Date.now() - 1000).toISOString(),
              validUntil: expiresAt,
              documents: [],
            },
          },
        }),
      );
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(
        page.getByRole("heading", { name: "Synthetic Busy Store", exact: true }),
      ).toBeVisible();
      busyUntil = Date.now() + 2_500;
      await page.evaluate(() => {
        history.pushState(null, "", "/checkout");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      const busy = page.getByRole("alert").filter({ hasText: "The store’s system is busy" });
      await expect(busy).toBeVisible();
      await expect(busy).toContainText("Your cart is kept. It loads again by itself in 2 seconds.");
      await expect(busy.getByRole("button", { name: "Try again" })).toBeVisible();
      // Never a dead button that does nothing.
      await expect(page.getByRole("button", { name: /Continue to payment/u })).toHaveCount(0);
      await expectNoInternalText(page);
      await page.screenshot({
        path: test.info().outputPath("checkout-busy-" + screen.width + ".png"),
      });
      // Read again by itself: the order and its total, and the way on.
      await expect(page.getByRole("heading", { name: "Total", exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Synthetic noodles")).toBeVisible();
      await expect(page.getByText("$2.83").first()).toBeVisible();
      await expect(busy).toHaveCount(0);
      expect(busyAnswers).toBeGreaterThan(0);
      await page.screenshot({
        path: test.info().outputPath("checkout-after-busy-" + screen.width + ".png"),
      });
      expect(failures).toEqual([]);
    });
  });
}
