import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Coordinator 2026-10-30: a phone scanning a table no party is seated at (free, or waiting for
// cleaning) is told so before joining, can browse the menu, and adding a dish says it can order
// once staff seat it, never "session expired". Synthetic owner answers on the production PWA; the
// server side (the table state read under the pilot API role) is proven by the database
// acceptance test (public store profile: dining entry).
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function scanNotOpenTable(page: Page) {
  const at = new Date().toISOString();
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Noodle Bar",
        publicStoreReference: id(4),
        publicTableReference: id(5),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        tableOpen: false,
        csrfToken: "s".repeat(43),
      },
    }),
  );
  await page.route("**/api/v1/public/stores/*/menu?*", (route) =>
    route.fulfill({
      status: 200,
      json: {
        status: "Found",
        schemaVersion: 1,
        projection: {
          name: "catalog_published_menu_v1",
          version: 1,
          asOfUtc: at,
          sourceCheckpoint: id(6),
          sourceAggregateVersion: 1,
          freshnessStatus: "Fresh",
          freshnessTargetMilliseconds: 5000,
          stale: false,
          partial: true,
        },
        scope: {
          publicStoreReference: id(4),
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "DINE_IN",
          effectiveAt: at,
        },
        menu: {
          menuReference: id(7),
          menuVersionReference: id(8),
          releaseReference: id(9),
          locale: "en-CA",
          name: "Synthetic menu",
          effectiveFrom: at,
          effectiveUntil: null,
          sections: [
            {
              sectionReference: id(10),
              name: "Drinks",
              sellables: [
                {
                  sellableReference: id(3),
                  productVersionReference: id(11),
                  name: "Synthetic tea",
                  description: null,
                  photo: null,
                  presentationRole: "Standard",
                  pinned: false,
                  availability: "Available",
                  optionRules: [],
                  allergenDisclosure: {
                    registryVersionReference: id(12),
                    items: [],
                    allergenFreeClaim: false,
                    assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                  },
                  displayPrice: {
                    status: "Available",
                    amount: "4.50",
                    currency: "CAD",
                    reason: null,
                  },
                  taxDisplayContext: {
                    status: "Unavailable",
                    taxInclusive: null,
                    reason: "FINAL_QUOTE_REQUIRED",
                  },
                },
              ],
            },
          ],
        },
      },
    }),
  );
  // The server refuses a cart for a phone that scanned but wasn't seated (no cart is created).
  const notSeated = {
    status: 409,
    headers: { "cache-control": "no-store" },
    json: {
      schemaVersion: 1,
      error: { code: "cart_dining_not_seated", messageKey: "customer.cart.dining_not_seated" },
    },
  };
  await page.route("**/bff/customer/cart", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: { schemaVersion: 1, cart: null },
        })
      : route.fulfill(notSeated),
  );
  await page.route("**/bff/customer/cart-binding/*", (route) => route.fulfill(notSeated));
  await page.route("**/api/v1/carts**", (route) => route.fulfill(notSeated));
  await page.goto("/#qr=aaa.bbb.ccc");
}

test.describe("@production CUST-ENTRY table not open", () => {
  test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });

  test("says the table isn't open yet, keeps the menu, and explains ordering waits for seating", async ({
    page,
  }) => {
    await scanNotOpenTable(page);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "This table isn’t open yet" })).toBeVisible();
    await expect(main).toContainText("Ask staff to seat you, then scan again.");
    await expect(main).not.toContainText("Ready to order");
    await expect(main).not.toContainText("is confirmed for dine-in");
    await expect(main.getByRole("button", { name: "Join this table" })).toHaveCount(0);
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/customer-table-not-open-390.png", fullPage: true });

    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(main.getByRole("heading", { name: "这桌还没开台" })).toBeVisible();
    await expect(main).toContainText("请让店员带位，开台后再扫一次码。");
    await page.screenshot({
      path: "test-results/customer-table-not-open-zh-390.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "English" }).click();

    // Browsing the menu works; adding a dish explains why it can't be ordered yet.
    await main.getByRole("button", { name: "Look at the menu first" }).click();
    await page.getByRole("link", { name: "View Synthetic tea", exact: true }).click();
    await page.getByRole("button", { name: "Add to cart", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "You can order once staff seat you. Ask a staff member, then scan again.",
    );
    await expect(page.getByText("Session expired")).toHaveCount(0);
    await expect(page.getByText("Scan the location QR code again")).toHaveCount(0);
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/customer-not-seated-add-390.png", fullPage: true });
  });

  test("a guest whose table was just settled scans it again: thanked, with the receipt", async ({
    page,
  }) => {
    // The restore (the ended visit's cookie) says the table was settled; its receipt is read with
    // that visit's value before the scan starts a new visit.
    const order: string[] = [];
    await page.route("**/api/v1/customer/session/csrf", (route) => {
      order.push("restore");
      return route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { schemaVersion: 1, settledTable: { tableLabel: "12", csrfToken: "e".repeat(43) } },
      });
    });
    await page.route("**/api/v1/dine-in/table-payment", (route) => {
      order.push("receipt");
      expect(route.request().headers()["x-csrf-token"]).toBe("e".repeat(43));
      return route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 1,
          receipt: {
            tableLabel: "12",
            rounds: [
              {
                roundNumber: 1,
                fromTableLabel: null,
                items: [{ displayName: "Milk tea", subtotalMinor: "450", reduced: null }],
              },
            ],
            subtotalMinor: "450",
            taxMinor: "59",
            ordersTotalMinor: "509",
            tipMinor: "0",
            roundingMinor: "1",
            paidMinor: "510",
            split: false,
            payments: [{ partNumber: null, method: "Cash", totalMinor: "510" }],
          },
        },
      });
    });
    page.on("request", (request) => {
      if (request.url().endsWith("/bff/customer/entry")) order.push("entry");
    });
    await scanNotOpenTable(page);
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "This table is settled. Thank you for dining with us." }),
    ).toBeVisible();
    await expect(main).toContainText("Table 12 has paid and closed.");
    await expect(main.getByRole("region", { name: "Receipt" })).toContainText("Total paid$5.10");
    await expect(main.getByRole("region", { name: "Receipt" })).toContainText("Paid byCash");
    await expect(main).toContainText("New party? Ask staff to seat you, then scan again.");
    await expect(main).not.toContainText("This table isn’t open yet");
    expect(order).toEqual(["restore", "receipt", "entry"]);
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/customer-settled-rescan-390.png", fullPage: true });
  });
});
