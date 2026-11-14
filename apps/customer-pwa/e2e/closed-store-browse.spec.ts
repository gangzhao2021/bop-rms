import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

test.beforeEach(({ context }) => routeStorefrontReads(context));

/**
 * M116: a guest who scans while the Store is closed (or paused) looks at its menu, read-only, and
 * asks again whether it's open; there is no Cart or Order link to a dead end. Synthetic HTTP
 * answers, no live Store authority.
 */
const id = (n: number) => "018f8a20-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const closed = {
  schemaVersion: 1,
  code: "entry_not_accepting",
  messageKey: "customer.entry.not_accepting",
  recovery: { action: "TryLaterOrAskStaff", storeSelection: "Hidden" },
  store: {
    storeDisplayName: "Synthetic Store",
    operatingState: "Closed",
    todayHours: [],
    todayKind: null,
    nextOpening: { localDate: "2026-12-23", startLocalTime: "11:00:00" },
    localDate: "2026-12-22",
    browse: {
      brandDisplayName: "Synthetic Brand",
      publicStoreReference: id(6),
      locale: "en-CA",
      channel: "Pickup",
    },
  },
};

test.describe("@production a closed Store's menu", () => {
  for (const width of [390, 1024]) {
    test(`is there to look at, with Check again and no dead Cart link (${width}px)`, async ({
      page,
    }) => {
      const entries: string[] = [];
      await page.route("**/bff/customer/entry", (route) => {
        entries.push(route.request().method());
        return route.fulfill({
          status: 409,
          headers: { "cache-control": "no-store" },
          json: closed,
        });
      });
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#qr=aaa.bbb.ccc");
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("Synthetic Store isn’t taking orders right now");
      const journey = page.getByRole("navigation", { name: "Customer journey" });
      await expect(journey.getByRole("link", { name: "Cart" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
      await page.screenshot({ path: `test-results/closed-entry-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "Look at the menu first" }).click();
      await expect(page).toHaveURL(/\/menu$/u);
      const notice = page.locator(".menu-closed-notice");
      await expect(notice).toContainText("Closed now · opens tomorrow at 11:00 a.m.");
      await expect(notice).toContainText("You can look at the menu.");
      await expect(page.getByRole("navigation", { name: "Customer journey" })).not.toContainText(
        "Cart",
      );
      await expect(page.locator(".menu-cart-bar, .menu-cart-panel")).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expectNoInternalText(page);
      await page.screenshot({ path: `test-results/closed-menu-${width}.png`, fullPage: true });
      // Check again goes back and asks the Store again, not the old answer.
      const asked = entries.length;
      await notice.getByRole("link", { name: "Check again" }).click();
      await expect(page.getByRole("alert")).toContainText("isn’t taking orders right now");
      await expect.poll(() => entries.length).toBeGreaterThan(asked);
    });
  }
});
