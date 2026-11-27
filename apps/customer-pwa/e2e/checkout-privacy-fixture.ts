import { expect, type Page } from "@playwright/test";

// Synthetic pickup checkout with the Store's privacy notice where contact details are collected
// (moved out of receipt-tax-privacy.spec.ts in batch 65 so the batch 65 spec measures the same
// page). TEST-ONLY values.
const id = (n: number) => "018f8815-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "c".repeat(43);
const privacyNoticeUrl = "https://example.test/privacy";

export async function checkout(page: Page, withPrivacy: boolean) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Checkout Store",
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
  await page.route("**/bff/customer/cart", (route) =>
    route.fulfill({
      status: 200,
      json: {
        schemaVersion: 1,
        cart: {
          cartReference: id(11),
          version: 3,
          orderType: "Pickup",
          serviceMode: "Pickup",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Checkout Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: [
            {
              cartItemReference: id(12),
              sellableReference: id(13),
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
  await page.route("**/bff/customer/checkout-details/current", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        checkout: { cartReference: id(11), cartVersion: 3, orderType: "Pickup", details: null },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details/policy", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        policy: {
          cartReference: id(11),
          cartVersion: 3,
          orderType: "Pickup",
          checkedAt: new Date(Date.now() - 1000).toISOString(),
          validUntil: expiresAt,
          documents: [],
          ...(withPrivacy ? { privacyNoticeUrl } : {}),
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
          quoteReference: id(14),
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
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Checkout Store", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    history.pushState(null, "", "/checkout");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: "Checkout", exact: true })).toBeVisible();
  await expect(page.getByText(/only to contact you about this order/u)).toBeVisible();
}
