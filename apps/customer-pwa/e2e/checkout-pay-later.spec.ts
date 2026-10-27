import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 DEC-DINE-IN-PAY-LATER: at a table that pays once at the end, the guest's round goes to
// the kitchen from the checkout — no tip and no payment step — and the table page then shows it
// in the kitchen and on the table's bill. Synthetic HTTP interception on the production PWA.
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => "018f8a00-0000-7000-8000-" + n.toString(16).padStart(12, "0");

async function stubTable(page: Page, sent: { body: unknown; key: string | undefined }[]) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const now = new Date().toISOString();
  let roundSent = false;
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ schemaVersion: 1, orderMessages: { sms: false, email: false } }),
    }),
  );
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Table Store",
        publicStoreReference: id(4),
        publicTableReference: id(5),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: expiresAt,
        csrfToken: "d".repeat(43),
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
          orderType: "DineIn",
          serviceMode: "DineIn",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Table Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: [
            {
              cartItemReference: id(2),
              sellableReference: id(3),
              displayName: "Synthetic noodles",
              quantity: 2,
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
          quoteReference: id(6),
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
        checkout: { cartReference: id(1), cartVersion: 3, orderType: "DineIn", details: null },
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
          orderType: "DineIn",
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
          quoteReference: body.quoteReference,
          quoteVersion: 1,
          orderType: "DineIn",
          receiptChoice: "InSession",
          recordedAt: new Date().toISOString(),
        },
      },
    });
  });
  await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
    const body = route.request().postDataJSON() as { quoteReference: string };
    return route.fulfill({
      status: 200,
      json: {
        schemaVersion: 1,
        session: {
          checkoutSessionReference: id(10),
          cartReference: id(1),
          cartVersion: 3,
          quoteReference: body.quoteReference,
          quoteVersion: 1,
          createdAt: now,
        },
      },
    });
  });
  await page.route("**/api/v1/checkout-sessions/*/payment-intents", async (route) => {
    const request = route.request();
    sent.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
    roundSent = true;
    await route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        round: {
          checkoutSessionReference: id(10),
          orderReference: id(20),
          status: "Sent",
          total: { amountMinor: "2260", currency: "CAD" },
        },
      },
    });
  });
  await page.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        session: {
          tableLabel: "12",
          orderNumber: roundSent ? "1042" : null,
          checkedAt: new Date().toISOString(),
          paymentTiming: "PayLater",
          rounds: roundSent
            ? [
                {
                  roundNumber: 1,
                  orderedBy: "You",
                  submittedAt: now,
                  status: "Queued",
                  payment: "OnTableBill",
                  cancelsAt: null,
                  storeCancellationReason: null,
                  items: [
                    {
                      displayName: "Synthetic noodles",
                      quantity: 2,
                      servedQuantity: 0,
                      cancelled: false,
                      lineTotal: { amountMinor: "2260", currencyCode: "CAD" },
                    },
                  ],
                  itemsTotal: { amountMinor: "2260", currencyCode: "CAD" },
                },
              ]
            : [],
          summary: roundSent
            ? {
                paid: { amountMinor: "0", currencyCode: "CAD" },
                refunded: { amountMinor: "0", currencyCode: "CAD" },
                refundPending: { amountMinor: "0", currencyCode: "CAD" },
                due: { amountMinor: "2260", currencyCode: "CAD" },
              }
            : null,
        },
      },
    }),
  );
}

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Pay-later table checkout " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("sends the round to the kitchen with no tip or payment step", async ({ page }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const sent: { body: unknown; key: string | undefined }[] = [];
      await stubTable(page, sent);
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(
        page.getByRole("heading", { name: "Synthetic Table Store", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        history.pushState(null, "", "/checkout");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      const send = page.getByRole("button", { name: /Send to the kitchen · \$22\.60/u });
      await expect(send).toBeEnabled();
      // The table chooses its tip once, when it pays at the end.
      await expect(page.getByRole("heading", { name: "Tip", exact: true })).toHaveCount(0);
      await expect(page.getByText("Nothing is charged now.", { exact: false })).toBeVisible();
      await expectNoInternalText(page);
      await send.click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      await expect(page.getByText("On the table's bill").first()).toBeVisible();
      await expect(page.getByText("To pay at the end")).toBeVisible();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body).toEqual({ sendToKitchen: true });
      expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
      expect(failures).toEqual([]);
    });
  });
}
