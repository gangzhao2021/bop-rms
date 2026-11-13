import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

test.beforeEach(({ context }) => routeStorefrontReads(context));
// Synthetic HTTP interception on the production PWA, not live Store or payment evidence.
// WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): a pickup guest reloaded the cart during
// a rush. The page's restore of the visit got no answer in time (the store was busy), so the page
// had no credential; the cart itself loaded, and Checkout said "Your session ended. Scan the
// location QR code again" with Continue to payment disabled, though the visit was fine. Now the
// page says the store is busy, keeps the cart, asks for the visit again by itself, and then shows
// the total and the way on.
const id = (n: number) => "018f8904-0000-7000-8000-" + n.toString(16).padStart(12, "0");

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet", width: 1024, height: 768, touch: true },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Checkout when the visit restore is busy " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("says the store is busy, never that the session ended, and then prices the order", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      // The store answers the visit restore "busy" until the rush passes, then restores it.
      let busy = true;
      let restoreAsks = 0;
      await page.route("**/api/v1/customer/session/csrf", (route) => {
        restoreAsks += 1;
        if (busy)
          return route.fulfill({
            status: 503,
            headers: { "retry-after": "5", "cache-control": "no-store" },
            json: { schemaVersion: 1, error: { code: "session_unavailable" } },
          });
        return route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 1,
            csrfToken: "e".repeat(43),
            menuContext: {
              publicStoreReference: id(4),
              channel: "Pickup",
              locale: "en-CA",
              brandDisplayName: "Synthetic Brand",
              storeDisplayName: "Synthetic Rush Store",
            },
          },
        });
      });
      await page.route("**/bff/customer/cart**", (route) =>
        route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 1,
            cart: {
              cartReference: id(1),
              version: 3,
              orderType: "Pickup",
              serviceMode: "Pickup",
              context: { brandName: "Synthetic Brand", storeName: "Synthetic Rush Store" },
              lifecycle: {
                status: "Active",
                idleExpiresAt: expiresAt,
                absoluteExpiresAt: expiresAt,
              },
              items: [
                {
                  cartItemReference: id(2),
                  sellableReference: id(3),
                  displayName: "Synthetic dumplings",
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
        }),
      );
      const quoteCredentials: string[] = [];
      await page.route("**/api/v1/carts/*/quote", (route) => {
        quoteCredentials.push(route.request().headers()["x-csrf-token"] ?? "");
        return route.fulfill({
          status: 201,
          json: {
            schemaVersion: 1,
            quote: {
              quoteReference: id(5),
              quoteVersion: 1,
              cartVersion: 3,
              currency: "CAD",
              subtotal: { amountMinor: "1250", currency: "CAD" },
              discount: { amountMinor: "0", currency: "CAD" },
              tax: { amountMinor: "163", currency: "CAD" },
              fee: { amountMinor: "0", currency: "CAD" },
              total: { amountMinor: "1413", currency: "CAD" },
              expiresAt,
              warnings: [],
              blockingReasons: [],
              priceChange: null,
            },
          },
        });
      });
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
      // A reload straight onto Checkout in the rush: the page's restore is answered "busy".
      await page.goto("/checkout");
      const alert = page.getByRole("alert").filter({ hasText: "The store’s system is busy" });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(
        "Your cart is kept. It loads again by itself in 5 seconds.",
      );
      await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(page.getByText(/session ended|Scan the location QR code/iu)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Continue to payment/u })).toHaveCount(0);
      await expectNoInternalText(page);
      await page.screenshot({
        path: test.info().outputPath("checkout-restore-busy-" + screen.width + ".png"),
      });
      expect(quoteCredentials).toEqual([]);
      // The rush passes: the page asks for the visit again by itself and prices the order.
      busy = false;
      await expect(page.getByRole("heading", { name: "Total", exact: true })).toBeVisible({
        timeout: 12_000,
      });
      await expect(page.getByText("Synthetic dumplings")).toBeVisible();
      await expect(page.getByText("$14.13").first()).toBeVisible();
      await expect(alert).toHaveCount(0);
      await expect(page.getByText(/session ended|Scan the location QR code/iu)).toHaveCount(0);
      expect(quoteCredentials).toEqual(["e".repeat(43)]);
      expect(restoreAsks).toBeGreaterThan(1);
      await page.screenshot({
        path: test.info().outputPath("checkout-restore-after-busy-" + screen.width + ".png"),
      });
      expect(failures).toEqual([]);
    });
  });
}
