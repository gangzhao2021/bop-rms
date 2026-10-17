import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
// Synthetic HTTP interception on the production PWA, not live Store/Pricing evidence.
// WP-2423 U1: one "Continue to payment" tap saves unsaved checkout details and then starts payment.
const id = (n: number) => "018f8900-0000-7000-8000-" + n.toString(16).padStart(12, "0");

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Checkout one tap " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("one tap saves the details, then continues to payment", async ({ page, context }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      page.on("console", (message) => {
        if (message.type() === "error") failures.push("unexpected console error");
      });
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      const csrf = "d".repeat(43);
      await page.route("**/bff/customer/entry", (route) =>
        route.fulfill({
          status: 201,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 2,
            status: "Established",
            brandDisplayName: "Synthetic Brand",
            storeDisplayName: "Synthetic One Tap Store",
            publicStoreReference: id(4),
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
      await page.route("**/bff/customer/cart", (route) =>
        route.fulfill({
          status: 200,
          json: {
            schemaVersion: 1,
            cart: {
              cartReference: id(1),
              version: 3,
              orderType: "Pickup",
              serviceMode: "Pickup",
              context: { brandName: "Synthetic Brand", storeName: "Synthetic One Tap Store" },
              lifecycle: {
                status: "Active",
                idleExpiresAt: expiresAt,
                absoluteExpiresAt: expiresAt,
              },
              items: [
                {
                  cartItemReference: id(2),
                  sellableReference: id(3),
                  displayName: "Synthetic tea",
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
              subtotal: { amountMinor: "100", currency: "CAD" },
              discount: { amountMinor: "0", currency: "CAD" },
              tax: { amountMinor: "13", currency: "CAD" },
              fee: { amountMinor: "0", currency: "CAD" },
              total: { amountMinor: "113", currency: "CAD" },
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
      const order: string[] = [];
      await page.route("**/bff/customer/checkout-details", async (route) => {
        const request = route.request(),
          body = request.postDataJSON() as Record<string, unknown>;
        order.push("details");
        // A slow acknowledgement: payment must still wait for it, then start without another tap.
        await new Promise((resolve) => setTimeout(resolve, 400));
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
      const sessionView = {
        schemaVersion: 1,
        session: {
          checkoutSessionReference: id(10),
          cartReference: id(1),
          cartVersion: 3,
          quoteReference: id(5),
          quoteVersion: 1,
          createdAt: new Date().toISOString(),
        },
      };
      await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
        order.push("session");
        return route.fulfill({ status: 200, json: sessionView });
      });
      // The payment step is covered by checkout-continuity; here its requests stay pending.
      await page.route("**/api/v1/checkout-sessions/**", () => new Promise<void>(() => undefined));
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(
        page.getByRole("heading", { name: "Synthetic One Tap Store", exact: true }),
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
      // v15 aa3d9fac D1: losing the connection is not a refusal. The page says it is offline,
      // keeps the cart and the details, and never asks the guest to rescan the QR code.
      await context.setOffline(true);
      await expect(
        page.getByText(
          "You’re offline. Reconnect to continue; nothing will be submitted automatically.",
        ),
      ).toBeVisible();
      await expect(
        page.getByText("We couldn’t continue this checkout", { exact: false }),
      ).toHaveCount(0);
      await expect(page.getByText(/scan the QR code/u)).toHaveCount(0);
      await expect(proceed).toBeDisabled();
      await expect(page.getByLabel("Pickup name", { exact: true })).toHaveValue("Synthetic Guest");
      await context.setOffline(false);
      await expect(proceed).toBeEnabled();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expectNoInternalText(page);
      if (screen.touch) await proceed.tap();
      else await proceed.click();
      await expect(page.getByText("Saving your details…", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/checkout\/payment$/u);
      expect(order).toEqual(["details", "session"]);
      expect(failures).toEqual([]);
    });
  });
}
