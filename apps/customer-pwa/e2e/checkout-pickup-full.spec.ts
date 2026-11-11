import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
// Synthetic HTTP interception on the production PWA, not live Store, stock or payment evidence.
// WP-2423 (checkout-session-outage, v15 2026-11-11): when the kitchen's online pickup orders for
// this hour are full, checkout says so plainly (nothing charged; try again shortly or order at the
// counter), keeps "Retry checkout" for the same checkout, never retries by itself, and no payment
// starts. It is never told as the system being down.
const id = (n: number) => "018f8902-0000-7000-8000-" + n.toString(16).padStart(12, "0");

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet", width: 1024, height: 768, touch: true },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Checkout when pickup is full " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("says the kitchen is booked, charges nothing and lets the guest try again", async ({
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
      const operations: (string | undefined)[] = [];
      await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
        operations.push(route.request().headers()["idempotency-key"]);
        return route.fulfill({
          status: 409,
          headers: { "retry-after": "60" },
          json: {
            schemaVersion: 1,
            error: {
              code: "checkout_session_pickup_full",
              messageKey: "customer.checkoutSession.pickup_full",
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
      // WP-2423 item 8 ⑦: no tip is chosen for the guest; the guest chooses one.
      await page.getByRole("button", { name: "No tip", exact: true }).click();
      const proceed = page.getByRole("button", { name: /Continue to payment/u });
      await expect(proceed).toBeEnabled();
      if (screen.touch) await proceed.tap();
      else await proceed.click();
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("The kitchen is fully booked for pickup orders right now");
      await expect(alert).toContainText("hasn’t been charged");
      await expect(alert).toContainText("order at the counter");
      await expect(page.getByText("couldn’t start your checkout", { exact: false })).toHaveCount(0);
      // Not an outage: asked once, never again by itself.
      await page.waitForTimeout(2_000);
      expect(operations).toHaveLength(1);
      const retry = page.getByRole("button", { name: "Retry checkout" });
      await expect(retry).toBeVisible();
      if (screen.touch) await retry.tap();
      else await retry.click();
      // The same checkout is asked again (a place may have freed up).
      await expect.poll(() => operations.length).toBe(2);
      expect(operations[1]).toBe(operations[0]);
      expect(payments).toEqual([]);
      expect(cartWrites).toEqual([]);
      await expectNoInternalText(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(failures).toEqual([]);
    });
  });
}
