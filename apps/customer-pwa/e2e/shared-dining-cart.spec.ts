import { expect, test } from "@playwright/test";
const id = (n: number) => `018f2320-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
// Synthetic HTTP views exercise the production UI; these fixtures grant no real membership.
for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "mobile", width: 390, height: 844, touch: true },
]) {
  test.describe("@production shared Dining Cart " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("permits own controls and explains read-only shared items", async ({ page, context }) => {
      const errors: string[] = [];
      page.on("pageerror", () => errors.push("page error"));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push("console error");
      });
      const expiresAt = new Date(Date.now() + 600000).toISOString();
      let quantity = 2,
        version = 1;
      const mutations: string[] = [];
      const item = (own: boolean) => ({
        cartItemReference: id(own ? 2 : 3),
        sellableReference: id(own ? 4 : 5),
        displayName: own ? "Synthetic own tea" : "Synthetic shared tea",
        quantity: own ? quantity : 2,
        configuration: [],
        customerNote: own ? "Synthetic own note" : "Synthetic foreign note must remain hidden",
        lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
        warnings: own ? [] : ["OTHER_PARTICIPANT_ITEM"],
      });
      const view = () => ({
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version,
          orderType: "DineIn",
          serviceMode: "DineIn",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Dining Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: [item(true), item(false)],
          quote: null,
          warnings: [],
        },
      });
      await page.route("**/bff/customer/entry", (route) =>
        route.fulfill({
          status: 201,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 2,
            status: "Established",
            brandDisplayName: "Synthetic Brand",
            storeDisplayName: "Synthetic Dining Store",
            publicStoreReference: id(6),
            publicTableReference: id(7),
            channel: "DineIn",
            operatingState: "Open",
            availableServiceModes: ["DineIn"],
            locale: "en-CA",
            contextExpiresAt: expiresAt,
            csrfToken: "s".repeat(43),
          },
        }),
      );
      await page.route("**/bff/customer/cart", (route) =>
        route.fulfill({ status: 200, headers: { "cache-control": "no-store" }, json: view() }),
      );
      await page.route("**/api/v1/carts/*/items/*", async (route) => {
        const request = route.request();
        mutations.push(new URL(request.url()).pathname);
        if (!request.url().endsWith(id(2))) {
          await route.fulfill({
            status: 403,
            json: { error: { code: "cart_service_unavailable" } },
          });
          return;
        }
        expect(request.method()).toBe("PATCH");
        expect(request.headers()["x-csrf-token"]).toBe("s".repeat(43));
        expect(request.headers()["if-match"]).toBe('"1"');
        quantity = 3;
        version = 2;
        await route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: view(),
        });
      });
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(
        page.getByRole("heading", { name: "Synthetic Dining Store", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        history.pushState(null, "", "/cart");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.getByRole("heading", { name: "Your cart", exact: true })).toBeVisible();
      const own = page
        .locator("article")
        .filter({ has: page.getByRole("heading", { name: "Synthetic own tea" }) });
      const foreign = page
        .locator("article")
        .filter({ has: page.getByRole("heading", { name: "Synthetic shared tea" }) });
      const explanation = "Added by another guest. Only they can change this item.";
      await expect(foreign.getByText(explanation, { exact: true })).toBeVisible();
      await expect(
        page.getByText("Synthetic foreign note must remain hidden", { exact: false }),
      ).toHaveCount(0);
      await expect(page.getByText("OTHER_PARTICIPANT_ITEM", { exact: false })).toHaveCount(0);
      for (const button of await foreign.getByRole("button").all()) {
        await expect(button).toBeDisabled();
        await expect(button).toHaveAccessibleDescription(explanation);
        const box = await button.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
      await expect(
        own.getByRole("button", { name: "Increase Synthetic own tea quantity" }),
      ).toBeEnabled();
      await own.getByRole("button", { name: "Increase Synthetic own tea quantity" }).click();
      await expect(own.getByRole("status", { name: "Synthetic own tea quantity" })).toHaveText("3");
      expect(mutations).toEqual([`/api/v1/carts/${id(1)}/items/${id(2)}`]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([
        0, 0,
      ]);
      await context.setOffline(true);
      await expect(page.getByText(/Offline read-only\. Changes and checkout/)).toBeVisible();
      await expect(
        own.getByRole("button", { name: "Increase Synthetic own tea quantity" }),
      ).toBeDisabled();
      expect(mutations).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  });
}
