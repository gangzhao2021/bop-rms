import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));

/**
 * WP-2423 item 8 ③ (Owner decision 13): on the table page, "Order again" puts one more of a dish
 * the table ordered — with the same choices, never the other guest's note — into this guest's own
 * cart; if the menu changed, the guest is sent to the dish on the menu. Synthetic HTTP answers.
 */
const id = (n: number) => `018f8a40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const csrf = "o".repeat(43);
const dumpling = id(20);
const spicy = id(21);
const session = {
  schemaVersion: 1,
  session: {
    tableLabel: "8",
    orderNumber: "2001",
    checkedAt: "2026-10-28T23:00:00.000Z",
    rounds: [
      {
        roundNumber: 1,
        orderedBy: "AnotherGuest",
        submittedAt: "2026-10-28T22:50:00.000Z",
        status: "Preparing",
        payment: "Paid",
        cancelsAt: null,
        storeCancellationReason: null,
        items: [
          {
            displayName: "Pork and chive dumplings (TEST)",
            quantity: 2,
            servedQuantity: 0,
            cancelled: false,
            lineTotal: cad("2486"),
            orderAgain: {
              sellableReference: dumpling,
              optionSelections: [{ optionReference: spicy, quantity: 1 }],
            },
          },
        ],
        itemsTotal: cad("2486"),
      },
    ],
    summary: { paid: cad("2486"), refunded: cad("0"), refundPending: cad("0"), due: cad("0") },
  },
};

function cart(version: number, items: unknown[]) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  return {
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version,
      orderType: "DineIn",
      serviceMode: "DineIn",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Dumpling House" },
      lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
      items,
      quote: null,
      warnings: [],
    },
  };
}

async function enterTable(page: Page) {
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Dumpling House",
        publicStoreReference: id(6),
        publicTableReference: id(7),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: csrf,
      },
    }),
  );
  await page.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill({ status: 200, headers: { "cache-control": "no-store" }, json: session }),
  );
  await page.route("**/api/v1/dine-in/staff-call", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, staffCall: { open: null, recentlyClosed: null, nextCallAt: null } },
    }),
  );
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, invitation: { canInvite: false } },
    }),
  );
  await page.route("**/bff/customer/cart**", (route) =>
    route.fulfill({ status: 200, headers: { "cache-control": "no-store" }, json: cart(1, []) }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Dumpling House", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    history.pushState(null, "", "/dine-in/session");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: "Your table · 8" })).toBeVisible();
}

test.describe("@production order a dish again from the table", () => {
  test.use({ serviceWorkers: "block" });

  test("adds one more with the same choices to this guest's own cart", async ({ page }) => {
    const posted: unknown[] = [];
    await enterTable(page);
    await page.route("**/api/v1/carts/*/items", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
      posted.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: cart(2, [
          {
            cartItemReference: id(30),
            sellableReference: dumpling,
            displayName: "Pork and chive dumplings (TEST)",
            quantity: 1,
            configuration: [],
            customerNote: null,
            lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
            warnings: [],
          },
        ]),
      });
    });
    const again = page.getByRole("button", {
      name: "Order one more Pork and chive dumplings (TEST)",
    });
    await again.click();
    await expect(
      page.getByText("One more Pork and chive dumplings (TEST) is in your cart."),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "View cart" })).toHaveAttribute("href", "/cart");
    expect(posted).toEqual([
      {
        sellableReference: dumpling,
        quantity: 1,
        customerNote: null,
        optionSelections: [{ optionReference: spicy, quantity: 1 }],
      },
    ]);
    await expectNoInternalText(page);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page
        .getByRole("region", { name: "Rounds" })
        .screenshot({ path: `test-results/order-again-${width}.png` });
    }
    // In Chinese: "再来一份".
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(page.getByRole("button", { name: /^再来一份/u })).toBeVisible();
  });

  test("sends the guest to the dish on the menu when it can't be added as before", async ({
    page,
  }) => {
    await enterTable(page);
    await page.route("**/api/v1/carts/*/items", (route) =>
      route.fulfill({
        status: 422,
        headers: { "cache-control": "no-store" },
        json: { error: { code: "cart_selection_invalid", issueCodes: ["OPTION_UNAVAILABLE"] } },
      }),
    );
    await page
      .getByRole("button", { name: "Order one more Pork and chive dumplings (TEST)" })
      .click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("can’t be added as it was ordered — the menu has changed.");
    await expect(alert.getByRole("link", { name: "Choose it from the menu" })).toHaveAttribute(
      "href",
      `/menu/items/${dumpling}`,
    );
  });
});
