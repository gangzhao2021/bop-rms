import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
// Synthetic HTTP interception on the production PWA, not live Store, stock or payment evidence.
// WP-2423 (v15 run of 8f655fc4): Flat White on two lines and a Mocha sharing the milk. Checkout
// says how many Flat White can be made and to remove one (the "−" stops at 1); the cart's Remove
// works; a "+" the stock can't make says how many can be made instead of a bare refusal.
const id = (n: number) => "018f8902-0000-7000-8000-" + n.toString(16).padStart(12, "0");

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Cart item short " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("tells the guest to remove one of two lines, removes it, and counts a refused +", async ({
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
        quantity: 1,
        configuration: [],
        customerNote: null,
        lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
        warnings: [],
      });
      let cart = {
        cartReference: id(1),
        version: 3,
        orderType: "Pickup",
        serviceMode: "Pickup",
        context: { brandName: "Synthetic Brand", storeName: "Synthetic Stock Store" },
        lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
        // v15 run: Flat White added twice (two lines of one) and a Mocha, sharing the milk.
        items: [
          line(2, 3, "Synthetic flat white"),
          line(4, 3, "Synthetic flat white"),
          line(6, 7, "Synthetic mocha"),
        ],
        quote: null,
        warnings: [],
      };
      await page.route("**/bff/customer/cart**", (route) =>
        route.fulfill({ status: 200, json: { schemaVersion: 1, cart } }),
      );
      const writes: string[] = [];
      await page.route("**/api/v1/carts/*/items/*", (route) => {
        const method = route.request().method();
        writes.push(method + " " + route.request().url().split("/items/")[1]);
        if (method === "DELETE") {
          cart = {
            ...cart,
            version: 4,
            items: cart.items.filter((item) => item.cartItemReference !== id(4)),
          };
          return route.fulfill({ status: 200, json: { schemaVersion: 1, cart } });
        }
        // The store can make one Mocha: a second is refused with the count.
        return route.fulfill({
          status: 422,
          json: {
            schemaVersion: 1,
            error: {
              code: "cart_selection_invalid",
              messageKey: "customer.cart.selection_invalid",
              issueCodes: ["ITEM_SHORT"],
              available: 1,
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
      await page.route("**/api/v1/carts/*/checkout-sessions", (route) =>
        route.fulfill({
          status: 409,
          json: {
            schemaVersion: 1,
            error: {
              code: "checkout_session_item_short",
              messageKey: "customer.checkoutSession.item_short",
              line: { cartItemReference: id(2), available: 1, sharedStock: false },
            },
          },
        }),
      );
      const payments: string[] = [];
      await page.route("**/api/v1/checkout-sessions/**", (route) => {
        payments.push(route.request().url());
        return route.abort();
      });
      const press = async (locator: ReturnType<typeof page.getByRole>) => {
        if (screen.touch) await locator.tap();
        else await locator.click();
      };
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
      await press(proceed);
      const alert = page.getByRole("alert").filter({ hasText: "Synthetic flat white" });
      await expect(alert).toHaveText(
        "Only 1 Synthetic flat white can be made right now — you have 2 in your cart. You haven’t been charged. Remove one Synthetic flat white, then try again. Change your cart",
      );
      expect(payments).toEqual([]);
      await press(alert.getByRole("link", { name: "Change your cart" }));
      await expect(page).toHaveURL(/\/cart$/u);
      // Remove one Flat White line (its "−" is disabled at 1).
      const second = page.locator(`article[aria-labelledby="cart-item-${id(4)}"]`);
      await expect(
        second.getByRole("button", { name: "Decrease Synthetic flat white quantity" }),
      ).toBeDisabled();
      await press(second.getByRole("button", { name: "Remove" }));
      await expect(second).toHaveCount(0);
      await expect(page.getByText("2 items", { exact: true })).toBeVisible();
      // A second Mocha the stock can't make: the count, not "can't be ordered as selected".
      await press(page.getByRole("button", { name: "Increase Synthetic mocha quantity" }));
      await expect(page.getByRole("heading", { name: "Not enough left" })).toBeVisible();
      await expect(
        page.getByText(
          "Only 1 Synthetic mocha can be made right now, so we couldn’t add more. Your cart is unchanged.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByText("can’t be ordered as selected")).toHaveCount(0);
      expect(writes).toEqual(["DELETE " + id(4), "PATCH " + id(6)]);
      await expectNoInternalText(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(failures).toEqual([]);
    });
  });
}
