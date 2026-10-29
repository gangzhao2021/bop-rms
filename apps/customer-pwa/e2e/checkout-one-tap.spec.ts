import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
// Synthetic HTTP interception on the production PWA, not live Store/Pricing evidence.
// WP-2423 U1: one "Continue to payment" tap saves unsaved checkout details and then starts payment.
const id = (n: number) => "018f8900-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** Synthetic Pickup checkout; each quote call can return its own quote reference, as the Store does. */
async function stubCheckout(
  page: Page,
  options: {
    readonly quoteReference: (call: number) => string;
    readonly details?: (call: number) => Promise<"abort" | "save"> | "abort" | "save";
  },
) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const csrf = "d".repeat(43);
  // DEC-PILOT-NOTIFICATIONS: the store's answer while no message channel is connected.
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
  let quoteCalls = 0;
  await page.route("**/api/v1/carts/*/quote", (route) => {
    quoteCalls += 1;
    return route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        quote: {
          quoteReference: options.quoteReference(quoteCalls),
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
    });
  });
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
    if ((await options.details?.(order.filter((step) => step === "details").length)) === "abort")
      return route.abort("internetdisconnected");
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
          quoteReference: body.quoteReference,
          quoteVersion: 1,
          orderType: "Pickup",
          receiptChoice: "InSession",
          recordedAt: new Date().toISOString(),
        },
      },
    });
  });
  await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
    order.push("session");
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
          createdAt: new Date().toISOString(),
        },
      },
    });
  });
  // The payment step is covered by checkout-continuity; here its requests stay pending.
  await page.route("**/api/v1/checkout-sessions/**", () => new Promise<void>(() => undefined));
  return { order, quoteCalls: () => quoteCalls };
}

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
      const { order } = await stubCheckout(page, { quoteReference: () => id(5) });
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
      // WP-2423 item 8 ⑦: no tip is chosen for the guest; the guest chooses one.
      await page.getByRole("button", { name: "No tip", exact: true }).click();
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
    // v15 2026-10-17: reconnecting re-prices the cart under a new quote. The pickup name and
    // number the guest typed (and the tip) stay, and nothing is sent until they continue.
    test("typed details survive a reconnect and its new quote", async ({ page, context }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const { order, quoteCalls } = await stubCheckout(page, {
        quoteReference: (call) => id(20 + call),
      });
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(
        page.getByRole("heading", { name: "Synthetic One Tap Store", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        history.pushState(null, "", "/checkout");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.getByRole("heading", { name: "Total", exact: true })).toBeVisible();
      const name = page.getByLabel("Pickup name", { exact: true });
      const phone = page.getByLabel("Mobile number", { exact: true });
      await name.fill("Synthetic Guest");
      await phone.fill("416 555 0123");
      await page.getByRole("button", { name: /^15%/u }).click();
      expect(quoteCalls()).toBe(1);
      await context.setOffline(true);
      await expect(
        page.getByText(
          "You’re offline. Reconnect to continue; nothing will be submitted automatically.",
        ),
      ).toBeVisible();
      await context.setOffline(false);
      await expect.poll(quoteCalls).toBe(2);
      const proceed = page.getByRole("button", { name: /Continue to payment/u });
      await expect(proceed).toBeEnabled();
      await expect(name).toHaveValue("Synthetic Guest");
      await expect(phone).toHaveValue("416 555 0123");
      await expect(page.getByRole("button", { name: /^15%/u })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(order).toEqual([]);
      await expectNoInternalText(page);
      if (screen.touch) await proceed.tap();
      else await proceed.click();
      await expect(page).toHaveURL(/\/checkout\/payment$/u);
      expect(order).toEqual(["details", "session"]);
      expect(failures).toEqual([]);
    });

    test("going offline during the save shows only the offline notice", async ({
      page,
      context,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      let releaseFirstSave: () => void = () => undefined;
      const firstSaveHeld = new Promise<void>((resolve) => (releaseFirstSave = resolve));
      const { order, quoteCalls } = await stubCheckout(page, {
        quoteReference: (call) => id(30 + call),
        details: async (call) => {
          if (call > 1) return "save";
          await firstSaveHeld;
          return "abort";
        },
      });
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(
        page.getByRole("heading", { name: "Synthetic One Tap Store", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        history.pushState(null, "", "/checkout");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.getByRole("heading", { name: "Total", exact: true })).toBeVisible();
      const name = page.getByLabel("Pickup name", { exact: true });
      const phone = page.getByLabel("Mobile number", { exact: true });
      await name.fill("Synthetic Guest");
      await phone.fill("416 555 0123");
      // WP-2423 item 8 ⑦: no tip is chosen for the guest; the guest chooses one.
      await page.getByRole("button", { name: "No tip", exact: true }).click();
      const proceed = page.getByRole("button", { name: /Continue to payment/u });
      if (screen.touch) await proceed.tap();
      else await proceed.click();
      await expect.poll(() => order.length).toBe(1);
      await context.setOffline(true);
      releaseFirstSave();
      await expect(
        page.getByText(
          "You’re offline. Reconnect to continue; nothing will be submitted automatically.",
        ),
      ).toBeVisible();
      await expect(
        page.getByText("We couldn’t confirm your details were saved", { exact: false }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retry saving details" })).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(1);
      await context.setOffline(false);
      await expect.poll(quoteCalls).toBe(2);
      await expect(proceed).toBeEnabled();
      await expect(name).toHaveValue("Synthetic Guest");
      await expect(phone).toHaveValue("416 555 0123");
      expect(order).toEqual(["details"]);
      await expectNoInternalText(page);
      if (screen.touch) await proceed.tap();
      else await proceed.click();
      await expect(page).toHaveURL(/\/checkout\/payment$/u);
      expect(order).toEqual(["details", "details", "session"]);
      expect(failures).toEqual([]);
    });
  });
}
