import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
// Synthetic HTTP interception on the production PWA, not live Store, stock or payment evidence.
// WP-2423 item 8 ⑦ s1 (v15 2026-10-29): when the store has closed or passed its last orders,
// checkout says why and offers the way back to the menu instead of a retry that cannot work now;
// no payment starts.
const id = (n: number) => "018f8902-0000-7000-8000-" + n.toString(16).padStart(12, "0");

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Checkout after closing " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("offers the way back, not a retry, once the store stopped taking orders", async ({
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
            storeDisplayName: "Synthetic Stock Store",
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
      const line = (reference: number, sellable: number, name: string) => ({
        cartItemReference: id(reference),
        sellableReference: id(sellable),
        displayName: name,
        quantity: 2,
        configuration: [],
        customerNote: null,
        lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
        warnings: [],
      });
      const cartWrites: string[] = [];
      await page.route("**/bff/customer/cart**", (route) => {
        if (route.request().method() !== "GET") cartWrites.push(route.request().method());
        return route.fulfill({
          status: 200,
          json: {
            schemaVersion: 1,
            cart: {
              cartReference: id(1),
              version: 3,
              orderType: "Pickup",
              serviceMode: "Pickup",
              context: { brandName: "Synthetic Brand", storeName: "Synthetic Stock Store" },
              lifecycle: {
                status: "Active",
                idleExpiresAt: expiresAt,
                absoluteExpiresAt: expiresAt,
              },
              items: [line(2, 3, "Synthetic latte"), line(6, 7, "Synthetic mocha")],
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
              subtotal: { amountMinor: "2000", currency: "CAD" },
              discount: { amountMinor: "0", currency: "CAD" },
              tax: { amountMinor: "260", currency: "CAD" },
              fee: { amountMinor: "0", currency: "CAD" },
              total: { amountMinor: "2260", currency: "CAD" },
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
      await page.route("**/bff/customer/checkout-details", async (route) => {
        const request = route.request(),
          body = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          json: {
            schemaVersion: 1,
            details: {
              operationReference: request.headers()["idempotency-key"],
              detailsReference: body.detailsReference,
              detailsVersion: 1,
              cartReference: id(1),
              cartVersion: 3,
              quoteReference: id(5),
              quoteVersion: 1,
              orderType: "Pickup",
              receiptChoice: "InSession",
              recordedAt: new Date().toISOString(),
            },
          },
        });
      });
      let sessions = 0;
      await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
        sessions += 1;
        return route.fulfill({
          status: 409,
          json: {
            schemaVersion: 1,
            error: {
              code: "checkout_session_store_closed",
              messageKey: "customer.checkoutSession.store_closed",
            },
          },
        });
      });
      const payments: string[] = [];
      await page.route("**/api/v1/checkout-sessions/**", (route) => {
        payments.push(route.request().url());
        return route.abort();
      });
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(
        page.getByRole("heading", { name: "Synthetic Stock Store", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        history.pushState(null, "", "/checkout");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.getByRole("heading", { name: "Total", exact: true })).toBeVisible();
      await page.getByLabel("Pickup name", { exact: true }).fill("Synthetic Guest");
      await page.getByLabel("Mobile number", { exact: true }).fill("416 555 0123");
      const proceed = page.getByRole("button", { name: /Continue to payment/u });
      await expect(proceed).toBeEnabled();
      if (screen.touch) await proceed.tap();
      else await proceed.click();
      // The explanation stays; Retry is replaced by the way back to the menu (a pickup order).
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry checkout" })).toHaveCount(0);
      const back = page.getByRole("link", { name: "Back to the menu", exact: true });
      await expect(back).toHaveAttribute("href", "/menu");
      expect(sessions).toBe(1);
      expect(payments).toEqual([]);
      expect(cartWrites).toEqual([]);
      await expectNoInternalText(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await back.click();
      await expect(page).toHaveURL(/\/menu$/u);
      expect(failures).toEqual([]);
    });
  });
}
