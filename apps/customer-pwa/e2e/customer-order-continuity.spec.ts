import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 Q10 synthetic HTTP evidence for the production App: keep the order reachable, say plainly
// when a visit has ended, and show how to reach the Store. No live Store, contact or Provider.
const id = (n: number) => "018f8800-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "c".repeat(43);
const orderReference = id(1);
const storeContact = {
  phone: "+14165550123",
  addressLines: ["DEMO 100 Test Street"],
  locality: "Toronto",
  regionCode: "ON",
  postalCode: "M5V 1A1",
};
const menuContext = {
  publicStoreReference: id(6),
  channel: "Pickup",
  locale: "en-CA",
  brandDisplayName: "Synthetic Brand",
  storeDisplayName: "Synthetic Continuity Store",
};
function status(withContact: boolean) {
  return {
    schemaVersion: 1,
    status: {
      projectionName: "ordering_order_status_v1",
      projectionVersion: 1,
      sourceCheckpoint: id(8),
      projectedAt: "2026-08-11T14:00:00.000Z",
      freshnessStatus: "Fresh",
      order: {
        orderReference,
        orderNumber: "12",
        orderType: "Pickup",
        canonicalPhase: "Submitted",
        paymentStatus: "NotReported",
        kitchenStatus: "Unavailable",
        fulfillmentStatus: "Unavailable",
        fulfilledAt: null,
        eta: null,
        submittedAt: "2026-08-11T13:55:00.000Z",
        batches: [
          {
            orderBatchReference: id(3),
            submittedAt: "2026-08-11T13:55:00.000Z",
            items: [
              {
                orderItemReference: id(4),
                displayName: "Synthetic tea",
                quantity: 1,
                lineTotal: { amountMinor: "450", currencyCode: "CAD" },
              },
            ],
          },
        ],
      },
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: null,
        payments: [
          {
            status: "Succeeded",
            occurredAt: "2026-08-11T13:56:00.000Z",
            amount: { amountMinor: "450", currencyCode: "CAD" },
            freshnessStatus: "Fresh",
          },
        ],
        ...(withContact ? { storeContact } : {}),
      },
    },
  };
}
const json = { "content-type": "application/json", "cache-control": "no-store" };
async function bootstrap(page: Page, body: Record<string, unknown> | null) {
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    body === null
      ? route.fulfill({
          status: 401,
          headers: json,
          body: JSON.stringify({ schemaVersion: 1, error: { code: "session_unavailable" } }),
        })
      : route.fulfill({ status: 200, headers: json, body: JSON.stringify(body) }),
  );
}
async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test.describe(`@production WP-2423 Q10 order continuity at ${viewport.width}px`, () => {
    test.use({ viewport, serviceWorkers: "block" });

    test("a reopened app offers the order this phone placed and opens it", async ({ page }) => {
      await bootstrap(page, {
        schemaVersion: 1,
        csrfToken: csrf,
        currentOrder: { orderReference, orderNumber: "12", orderType: "Pickup" },
        menuContext,
      });
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(status(true)) }),
      );
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Your order 12", exact: true })).toBeVisible();
      await expect(page.getByText("To start a new order, scan the QR code")).toBeVisible();
      await noHorizontalOverflow(page);
      await page.getByRole("link", { name: "View order 12", exact: true }).click();
      await expect(page).toHaveURL(new RegExp("/orders/" + orderReference + "$", "u"));
      await expect(page.getByText("Payment received $4.50", { exact: true })).toBeVisible();
      // How to reach the Store, from its published profile.
      const contact = page.getByRole("region", { name: "Contact the store" });
      await expect(contact).toBeVisible();
      await expect(contact.getByRole("link", { name: "Call (416) 555-0123" })).toHaveAttribute(
        "href",
        "tel:+14165550123",
      );
      await expect(contact.getByText("Toronto, ON M5V 1A1")).toBeVisible();
      await expectNoInternalText(page);
      await noHorizontalOverflow(page);
    });

    test("a QR code scanned again during an order shows the order before starting anew", async ({
      page,
    }) => {
      await bootstrap(page, {
        schemaVersion: 1,
        csrfToken: csrf,
        currentOrder: { orderReference, orderNumber: "12", orderType: "Pickup" },
        menuContext,
      });
      let entries = 0;
      await page.route("**/bff/customer/entry", (route) => {
        entries += 1;
        return route.fulfill({
          status: 201,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 2,
            status: "Established",
            brandDisplayName: "Synthetic Brand",
            storeDisplayName: "Synthetic Continuity Store",
            publicStoreReference: id(6),
            publicTableReference: null,
            channel: "Pickup",
            operatingState: "Open",
            availableServiceModes: ["Pickup"],
            locale: "en-CA",
            contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
            csrfToken: "d".repeat(43),
          },
        });
      });
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(page.getByRole("heading", { name: "Your order 12", exact: true })).toBeVisible();
      await expect(page.getByText("closes this order on this phone")).toBeVisible();
      expect(entries).toBe(0);
      await noHorizontalOverflow(page);
      await page.getByRole("button", { name: "Start a new order", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Ready to order", exact: true }),
      ).toBeVisible();
      expect(entries).toBe(1);
    });

    test("46940b76 L5: a browser that never placed the order is told plainly it isn't here", async ({
      page,
    }) => {
      await bootstrap(page, null);
      let statusCalls = 0;
      await page.route("**/api/v1/orders/*/status", (route) => {
        statusCalls += 1;
        return route.fulfill({ status: 404, headers: json, body: "{}" });
      });
      await page.goto("/orders/" + orderReference);
      await expect(
        page.getByRole("heading", {
          name: "This order isn’t available on this phone",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByText("give your order number to a staff member")).toBeVisible();
      await expect(page.getByText("Your visit on this phone has ended")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "View your receipt" })).toHaveCount(0);
      expect(statusCalls).toBe(0);
      await expectNoInternalText(page);
      await noHorizontalOverflow(page);
    });

    test("f5ae43a5: another table's guest opening this order is told it isn't on this phone", async ({
      page,
    }) => {
      // Signed in at another table: the server answers plain "not found" for an order this guest
      // did not place (a guest who just paid is answered "Order received" instead).
      await bootstrap(page, { schemaVersion: 1, csrfToken: csrf, menuContext });
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({ status: 404, headers: json, body: "{}" }),
      );
      await page.route("**/api/v1/orders/*/receipt", (route) =>
        route.fulfill({ status: 404, headers: json, body: "{}" }),
      );
      await page.goto("/orders/" + orderReference);
      await expect(
        page.getByRole("heading", {
          name: "This order isn’t available on this phone",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByText("give your order number to a staff member")).toBeVisible();
      await expect(page.getByText("If you just paid")).toHaveCount(0);
      await expect(page.getByText("can’t show this order")).toHaveCount(0);
      await expectNoInternalText(page);
      await noHorizontalOverflow(page);
      await page.goto("/orders/" + orderReference + "/receipt");
      await expect(
        page.getByRole("heading", { name: "Receipt not found", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("There’s no receipt for this order on this phone.", { exact: false }),
      ).toBeVisible();
      await expect(page.getByText(/authori[sz]ed/iu)).toHaveCount(0);
      await expectNoInternalText(page);
    });

    test("46940b76 L5: another guest at the open table is sent to the table's page", async ({
      page,
    }) => {
      await bootstrap(page, { schemaVersion: 1, csrfToken: csrf, menuContext });
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({
          status: 404,
          headers: json,
          body: JSON.stringify({
            schemaVersion: 1,
            error: {
              code: "order_status_table_order",
              messageKey: "customer.order.status.table_order",
            },
          }),
        }),
      );
      await page.goto("/orders/" + orderReference);
      await expect(
        page.getByRole("heading", {
          name: "Another guest at your table placed this order",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "See your table", exact: true })).toHaveAttribute(
        "href",
        "/dine-in/session",
      );
      await expect(page.getByText("If you just paid")).toHaveCount(0);
      await expectNoInternalText(page);
      await noHorizontalOverflow(page);
    });

    test("an ended visit explains the way back instead of 'access denied'", async ({ page }) => {
      // The visit that placed this order ended; its receipt stays readable for a while.
      await bootstrap(page, {
        schemaVersion: 1,
        endedVisit: {
          csrfToken: csrf,
          order: { orderReference, orderNumber: "12", orderType: "Pickup" },
          receiptAvailableUntil: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
      let statusCalls = 0;
      await page.route("**/api/v1/orders/*/status", (route) => {
        statusCalls += 1;
        return route.fulfill({ status: 404, headers: json, body: "{}" });
      });
      await page.goto("/orders/" + orderReference);
      await expect(
        page.getByRole("heading", { name: "Your visit on this phone has ended", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Scan the table QR code again")).toBeVisible();
      await expect(page.getByText("the store still has your order")).toBeVisible();
      await expect(page.getByText(/access denied|browser you used at checkout/iu)).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Go to the start", exact: true }),
      ).toHaveAttribute("href", "/");
      // Without a session there is nothing to ask the server for.
      expect(statusCalls).toBe(0);
      await noHorizontalOverflow(page);
    });
  });
}
