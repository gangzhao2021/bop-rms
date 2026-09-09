import { expect, test } from "@playwright/test";
// Synthetic HTTP interception on the production PWA, not live Store/Pricing evidence.
const id = (n: number) => "018f8800-0000-7000-8000-" + n.toString(16).padStart(12, "0");
for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Checkout continuity " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("retains one Quote intent across unknown, offline and explicit retry", async ({
      page,
      context,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          !(message.location().url.endsWith("/quote") && message.text().includes("503"))
        )
          failures.push("unexpected console error");
      });
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      const csrf = "c".repeat(43);
      const quoteCalls: { key: string | undefined; body: unknown }[] = [];
      const view = {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: 3,
          orderType: "Pickup",
          serviceMode: "Pickup",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Checkout Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
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
      };
      await page.route("**/bff/customer/entry", (route) =>
        route.fulfill({
          status: 201,
          json: {
            schemaVersion: 2,
            status: "Established",
            brandDisplayName: "Synthetic Brand",
            storeDisplayName: "Synthetic Checkout Store",
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
        route.fulfill({ status: 200, json: view }),
      );
      await page.route("**/api/v1/carts/*/quote", async (route) => {
        const request = route.request();
        expect(request.method()).toBe("POST");
        expect(request.headers()["x-csrf-token"]).toBe(csrf);
        quoteCalls.push({
          key: request.headers()["idempotency-key"],
          body: request.postDataJSON(),
        });
        if (quoteCalls.length === 1) {
          await route.fulfill({
            status: 503,
            json: {
              schemaVersion: 1,
              error: {
                code: "quote_service_unavailable",
                messageKey: "customer.quote.service_unavailable",
              },
            },
          });
          return;
        }
        await route.fulfill({
          status: 201,
          json: {
            schemaVersion: 1,
            quote: {
              quoteReference: id(5),
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
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(
        page.getByRole("heading", { name: "Synthetic Checkout Store", exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).hash).toBe("");
      // Native same-document route change retains the real Entry client's private CSRF context.
      await page.evaluate(() => {
        history.pushState(null, "", "/checkout");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(
        page.getByRole("heading", { name: "Review your order", exact: true }),
      ).toBeVisible();
      const fresh = page.getByRole("button", { name: "Get current quote", exact: true });
      await expect(fresh).toBeVisible();
      await fresh.focus();
      await page.keyboard.press("Enter");
      const retry = page.getByRole("button", { name: "Retry the same Quote request", exact: true });
      await expect(retry).toBeEnabled();
      await expect(fresh).toHaveCount(0);
      expect(quoteCalls).toHaveLength(1);
      await context.setOffline(true);
      await expect(retry).toBeDisabled();
      await expect(fresh).toHaveCount(0);
      expect(quoteCalls).toHaveLength(1);
      await context.setOffline(false);
      await expect(retry).toBeEnabled();
      expect(quoteCalls).toHaveLength(1);
      if (screen.touch) await retry.tap();
      else await retry.click();
      await expect(page.getByRole("heading", { name: "Quote summary", exact: true })).toBeVisible();
      await expect(page.getByText("CAD 1.13", { exact: true })).toBeVisible();
      await expect(retry).toHaveCount(0);
      expect(quoteCalls).toHaveLength(2);
      expect(quoteCalls[0]?.key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(quoteCalls[1]).toEqual(quoteCalls[0]);
      expect(quoteCalls[0]?.body).toEqual({ cartVersion: 3 });
      await expect(
        page.getByRole("button", { name: "Continue to payment", exact: true }),
      ).toBeDisabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      expect(failures).toEqual([]);
    });
  });
}
