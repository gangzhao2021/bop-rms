import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 shared-table-checkout (b, d). Synthetic HTTP (route fixtures standing in for the API) on
// the production PWA: a phone already at the table that scans its QR again is told so and goes on
// ordering (no join, no second visit); a cart change the Store's side answered 503 says plainly it
// couldn't be confirmed and its one button resends the same change with the same key. The server
// rules are proven by the API tests and the restricted-role database acceptance.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block", trace: "off", video: "off" });

const id = (n: number) => `018f2425-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const noStore = { "cache-control": "no-store" };
const json = { "cache-control": "no-store", "content-type": "application/json" };

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

for (const width of [390, 1024]) {
  test(`@production a re-scan on a phone already at the table says so and goes on ordering (${width})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", () => errors.push("page error"));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const asked: string[] = [];
    await page.route("**/bff/customer/entry", (route) =>
      route.fulfill({
        status: 200,
        headers: noStore,
        json: {
          schemaVersion: 2,
          status: "AlreadyAtTable",
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: "Synthetic Dining Store",
          publicStoreReference: id(6),
          publicTableReference: id(7),
          channel: "DineIn",
          locale: "en-CA",
        },
      }),
    );
    await page.route("**/api/v1/customer/session/csrf", (route) =>
      route.fulfill({
        headers: json,
        body: JSON.stringify({
          schemaVersion: 1,
          csrfToken: "c".repeat(43),
          menuContext: {
            publicStoreReference: id(6),
            channel: "DineIn",
            locale: "en-CA",
            brandDisplayName: "Synthetic Brand",
            storeDisplayName: "Synthetic Dining Store",
          },
        }),
      }),
    );
    for (const path of [
      "**/bff/customer/dining/qr-join",
      "**/bff/customer/dining/join",
      "**/bff/customer/dining-binding/**",
    ])
      await page.route(path, (route) => {
        asked.push(new URL(route.request().url()).pathname);
        return route.abort();
      });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "You’re already at this table." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue ordering", exact: true }),
    ).toBeVisible();
    // No second visit: nothing offers to join again.
    await expect(page.getByRole("button", { name: "Join this table", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Join code or invitation", { exact: true })).toHaveCount(0);
    await noHorizontalScroll(page);
    await expectNoInternalText(page);
    await page.screenshot({ path: `test-results/already-at-table-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Continue ordering", exact: true }).click();
    await expect(page).toHaveURL(/\/menu$/u);
    expect(asked).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`@production a remove the store couldn't confirm is retried with the same key (${width})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", () => errors.push("page error"));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    await page.route("**/bff/customer/entry", (route) =>
      route.fulfill({
        status: 201,
        headers: noStore,
        json: {
          schemaVersion: 2,
          status: "Established",
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: "Synthetic Cart Store",
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
    let cart = {
      cartReference: id(1),
      version: 3,
      orderType: "Pickup",
      serviceMode: "Pickup",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Cart Store" },
      lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
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
    };
    await page.route("**/bff/customer/cart**", (route) =>
      route.fulfill({ status: 200, json: { schemaVersion: 1, cart } }),
    );
    const keys: string[] = [];
    await page.route("**/api/v1/carts/*/items/*", (route) => {
      if (route.request().method() !== "DELETE") return route.abort();
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (keys.length === 1)
        return route.fulfill({
          status: 503,
          json: { schemaVersion: 1, error: { code: "cart_service_unavailable" } },
        });
      cart = { ...cart, version: 4, items: [] };
      return route.fulfill({ status: 200, json: { schemaVersion: 1, cart } });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Cart Store", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      history.pushState(null, "", "/cart");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByRole("button", { name: "Remove Synthetic noodles", exact: true }).click();
    await expect(page.getByText("We couldn’t confirm this change")).toBeVisible();
    await expect(
      page.getByText(
        "The network or the store’s system was busy. Trying again won’t change it twice.",
      ),
    ).toBeVisible();
    await noHorizontalScroll(page);
    await page.screenshot({ path: `test-results/remove-unconfirmed-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Try this again", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your cart is empty" })).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    await expectNoInternalText(page);
    expect(errors).toEqual([]);
  });
}
