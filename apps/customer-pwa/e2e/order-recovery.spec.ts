import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));

// DEC-PILOT-NOTIFICATIONS R1 (IDR-0031) synthetic HTTP evidence for the production App: the
// one-time order link page. No live Store, Provider or message.
const token = "T".repeat(43);
const orderReference = "018f8800-0000-7000-8000-000000000001";
const json = { "content-type": "application/json", "cache-control": "no-store" };

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test.describe(`@production one-time order link at ${viewport.width}px`, () => {
    test.use({ viewport, serviceWorkers: "block" });

    test("opens the order on this phone; the token never stays in the address bar or URL", async ({
      page,
    }) => {
      const posts: { url: string; body: string; referer: string | undefined }[] = [];
      let bootstraps = 0;
      await page.route("**/api/v1/customer/session/csrf", (route) => {
        bootstraps += 1;
        return route.fulfill({ status: 204, headers: { "cache-control": "no-store" } });
      });
      await page.route("**/api/v1/customer/order-recovery", (route) => {
        posts.push({
          url: route.request().url(),
          body: route.request().postData() ?? "",
          referer: route.request().headers()["referer"],
        });
        return route.fulfill({
          status: 200,
          headers: json,
          body: JSON.stringify({ schemaVersion: 1, redirectPath: `/orders/${orderReference}` }),
        });
      });
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({ status: 404, headers: json, body: "{}" }),
      );
      await page.goto(`/resume#t=${token}`);
      await expect(page).toHaveURL(new RegExp(`/orders/${orderReference}$`, "u"));
      expect(posts).toHaveLength(1);
      expect(posts[0]?.url).not.toContain(token);
      expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual({ token });
      expect(posts[0]?.referer ?? "").not.toContain(token);
      // Session bootstrap runs only on the order page, after the link was redeemed.
      await expect.poll(() => bootstraps).toBeGreaterThanOrEqual(1);
      const history = await page.evaluate(() => window.location.href);
      expect(history).not.toContain(token);
    });

    test("an expired or used link says so plainly and how to get the order", async ({ page }) => {
      await page.route("**/api/v1/customer/order-recovery", (route) =>
        route.fulfill({
          status: 400,
          headers: json,
          body: JSON.stringify({ schemaVersion: 1, error: { code: "order_link_unavailable" } }),
        }),
      );
      await page.goto(`/resume#t=${token}`);
      await expect(
        page.getByRole("heading", { name: "This link can’t open your order", exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/expired or was already used/u)).toBeVisible();
      await expect(
        page.getByText(/Give your name or order number to a staff member/u),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Go to the start" })).toHaveAttribute(
        "href",
        "/",
      );
      expect(new URL(page.url()).hash).toBe("");
      expect(new URL(page.url()).pathname).toBe("/resume");
      await expectNoInternalText(page);
      await noHorizontalOverflow(page);
    });

    test("a lost connection offers one more try with the same link", async ({ page }) => {
      let calls = 0;
      await page.route("**/api/v1/customer/order-recovery", (route) => {
        calls += 1;
        return calls === 1
          ? route.fulfill({ status: 503, headers: json, body: "{}" })
          : route.fulfill({
              status: 200,
              headers: json,
              body: JSON.stringify({ schemaVersion: 1, redirectPath: `/orders/${orderReference}` }),
            });
      });
      await page.route("**/api/v1/customer/session/csrf", (route) =>
        route.fulfill({ status: 204, headers: { "cache-control": "no-store" } }),
      );
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({ status: 404, headers: json, body: "{}" }),
      );
      await page.goto(`/resume#t=${token}`);
      await expect(
        page.getByRole("heading", { name: "We couldn’t reach the store", exact: true }),
      ).toBeVisible();
      await noHorizontalOverflow(page);
      await page.getByRole("button", { name: "Try again" }).click();
      await expect(page).toHaveURL(new RegExp(`/orders/${orderReference}$`, "u"));
      expect(calls).toBe(2);
    });
  });
}
