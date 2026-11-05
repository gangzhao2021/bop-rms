import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 DEC-MERCHANT-LOCK-SCOPE: an owner can list with the tables full. A guest part way through
// checkout is never stuck on a price that has gone: the page prices the cart again by itself, says
// why, and the guest checks the total and presses again. Nothing was sent or charged. Synthetic
// HTTP interception on the production PWA; the database acceptance test
// (listing-crosses-open-cart) proves the server's side with the real compositions.
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => "018f8a10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const notice = "The restaurant just updated its menu, so we priced your order again.";

interface Refusals {
  /** The checkout start is refused this many times. */
  startRefused: number;
  /** The send or payment is refused this many times. */
  sendRefused: number;
}
interface Seen {
  quotes: number;
  started: string[];
  sends: (string | undefined)[];
}

async function stubTable(page: Page, timing: "PayLater" | "PayFirst", refusals: Refusals) {
  const seen: Seen = { quotes: 0, started: [], sends: [] };
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const now = new Date().toISOString();
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
  await page.route("**/api/v1/carts/*/quote", (route) => {
    seen.quotes += 1;
    return route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        quote: {
          quoteReference: id(100 + seen.quotes),
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
    });
  });
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
  const session = (quoteReference: string) => ({
    schemaVersion: 1,
    session: {
      checkoutSessionReference: id(10),
      cartReference: id(1),
      cartVersion: 3,
      quoteReference,
      quoteVersion: 1,
      createdAt: now,
    },
  });
  let currentQuote = "";
  await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
    const body = route.request().postDataJSON() as { quoteReference: string };
    seen.started.push(body.quoteReference);
    if (refusals.startRefused > 0) {
      refusals.startRefused -= 1;
      return route.fulfill({
        status: 409,
        json: {
          schemaVersion: 1,
          error: {
            code: "checkout_session_requote_required",
            messageKey: "customer.checkoutSession.requote_required",
          },
        },
      });
    }
    currentQuote = body.quoteReference;
    return route.fulfill({ status: 200, json: session(body.quoteReference) });
  });
  await page.route("**/api/v1/checkout-sessions/*", (route) =>
    route.fulfill({ status: 200, json: session(currentQuote) }),
  );
  await page.route("**/api/v1/checkout-sessions/*/payment-intents", async (route) => {
    const request = route.request();
    seen.sends.push(request.headers()["idempotency-key"]);
    if (refusals.sendRefused > 0) {
      refusals.sendRefused -= 1;
      await route.fulfill({
        status: 422,
        json: {
          schemaVersion: 1,
          error: {
            code: "payment_requote_required",
            messageKey: "customer.payment.requote_required",
          },
        },
      });
      return;
    }
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
          orderNumber: null,
          checkedAt: new Date().toISOString(),
          paymentTiming: timing,
          rounds: [],
          summary: null,
        },
      },
    }),
  );
  return seen;
}

async function openCheckout(page: Page) {
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Table Store", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    history.pushState(null, "", "/checkout");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production A menu update during checkout " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });

    test("prices again when the checkout start finds the menu moved, and the guest sends", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const seen = await stubTable(page, "PayLater", { startRefused: 1, sendRefused: 0 });
      await openCheckout(page);
      const send = page.getByRole("button", { name: /Send to the kitchen · \$22\.60/u });
      await expect(send).toBeEnabled();
      await expect(page.getByText(notice, { exact: false })).toHaveCount(0);
      await send.click();
      await expect(page.getByText(notice, { exact: false })).toBeVisible();
      await expect(send).toBeEnabled();
      await expectNoInternalText(page);
      expect(seen.quotes).toBe(2);
      expect(seen.sends).toHaveLength(0);
      await send.click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      expect(seen.started).toEqual([id(101), id(102)]);
      expect(seen.sends).toHaveLength(1);
      expect(failures).toEqual([]);
    });

    test("prices again when the send finds the menu moved, and the round goes once", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const seen = await stubTable(page, "PayLater", { startRefused: 0, sendRefused: 1 });
      await openCheckout(page);
      const send = page.getByRole("button", { name: /Send to the kitchen · \$22\.60/u });
      await send.click();
      await expect(page.getByText(notice, { exact: false })).toBeVisible();
      await expect(send).toBeEnabled();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expectNoInternalText(page);
      await send.click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      expect(seen.started).toEqual([id(101), id(102)]);
      expect(seen.sends).toHaveLength(2);
      expect(seen.sends[0]).not.toBe(seen.sends[1]);
      expect(failures).toEqual([]);
    });

    test("the payment page says what happened and leads back to checkout", async ({ page }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const seen = await stubTable(page, "PayFirst", { startRefused: 0, sendRefused: 1 });
      await openCheckout(page);
      await page.getByRole("button", { name: "No tip", exact: true }).click();
      await page.getByRole("button", { name: /Continue to payment · \$22\.60/u }).click();
      await expect(page).toHaveURL(/\/checkout\/payment$/u);
      await expect(page.getByRole("heading", { name: "The menu was just updated" })).toBeVisible();
      await expect(page.getByText("so you haven’t been charged", { exact: false })).toBeVisible();
      await expect(
        page.getByText("We couldn’t confirm your payment", { exact: false }),
      ).toHaveCount(0);
      await expectNoInternalText(page);
      await page.getByRole("link", { name: "Back to checkout", exact: true }).click();
      await expect(page).toHaveURL(/\/checkout$/u);
      await expect(page.getByRole("button", { name: "No tip", exact: true })).toBeVisible();
      await expect.poll(() => seen.quotes).toBe(2);
      expect(failures).toEqual([]);
    });
  });
}
