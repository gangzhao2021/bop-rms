import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Coordinator 2026-10-30: a phone scanning a table no party is seated at (free, or waiting for
// cleaning) is told so before joining, can browse the menu, and adding a dish says it can order
// once staff seat it, never "session expired". Synthetic owner answers on the production PWA; the
// server side (the table state read under the pilot API role) is proven by the database
// acceptance test (public store profile: dining entry).
test.beforeEach(({ context }) => routeStorefrontReads(context));
const cartWrites: string[] = [];
const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function scanNotOpenTable(page: Page, entries: string[] = []) {
  const at = new Date().toISOString();
  // No party is seated: the scan starts no visit (no cookie) and gives the menu's public context.
  await page.route("**/bff/customer/entry", (route) => {
    entries.push(route.request().url());
    return route.fulfill({
      status: 409,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        code: "entry_table_not_open",
        messageKey: "customer.entry.table_not_open",
        recovery: { action: "AskStaff", storeSelection: "Hidden" },
        store: {
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: "Synthetic Noodle Bar",
          publicStoreReference: id(4),
          locale: "en-CA",
        },
      },
    });
  });
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
  // Without a visit nothing is sent to a cart; the page says why (recorded to prove it).
  await page.route("**/api/v1/carts**", (route) => {
    cartWrites.push(route.request().method());
    return route.abort();
  });
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
    expect(cartWrites).toEqual([]);
    await expect(page.getByText("Scan the location QR code again")).toHaveCount(0);
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/customer-not-seated-add-390.png", fullPage: true });
  });

  test("a guest whose table was just settled scans it again: thanked with the receipt, before and after", async ({
    page,
  }) => {
    // The scan starts no visit, so the ended visit (its cookie) stays: the restore says the
    // table was settled, the receipt is read with that visit's value, and a reload of the table
    // page still shows them.
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
    const entries: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/bff/customer/entry")) order.push("entry");
    });
    await scanNotOpenTable(page, entries);
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "This table is settled. Thank you for dining with us." }),
    ).toBeVisible();
    await expect(main).toContainText("Table 12 has paid and closed.");
    const receipt = main.getByRole("region", { name: "Receipt" });
    await expect(receipt).toContainText("Total paid$5.10");
    await expect(receipt).toContainText("Paid byCash");
    await expect(main).toContainText("New party? Ask staff to seat you, then scan again.");
    await expect(main).not.toContainText("This table isn’t open yet");
    expect(order).toEqual(["restore", "entry", "receipt"]);
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/customer-settled-rescan-390.png", fullPage: true });

    // After the scan, the table page (a fresh load) still thanks them with the receipt.
    await page.goto("/dine-in/session");
    await expect(
      main.getByRole("heading", { name: "This table is settled. Thank you for dining with us." }),
    ).toBeVisible();
    await expect(main.getByRole("region", { name: "Receipt" })).toContainText("Total paid$5.10");
    await expect(main).not.toContainText("Join your table first");
    expect(entries).toHaveLength(1);
  });
});
