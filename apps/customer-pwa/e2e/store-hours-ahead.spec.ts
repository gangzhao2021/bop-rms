import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));

/**
 * WP-2423 item 8 ③ (Owner decision 16): the menu ends with the Store — open until when, the
 * kitchen's last orders, today's hours, the holidays and special hours in the next 7 days, the
 * address and the phone a tap away — and a guest who scans while the Store is closed for a
 * holiday is told so and when it opens next. Synthetic HTTP answers, no live Store authority.
 */
const id = (n: number) => "018f8a20-0000-7000-8000-" + n.toString(16).padStart(12, "0");

async function enterOpen(page: Page) {
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Store",
        publicStoreReference: id(6),
        publicTableReference: null,
        channel: "Pickup",
        operatingState: "Open",
        availableServiceModes: ["Pickup"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: "h".repeat(43),
      },
    }),
  );
}

test.describe("@production the Store's hours ahead", () => {
  test.use({ serviceWorkers: "block" });

  test("the menu ends with the Store's hours, this week's holidays, address and phone", async ({
    page,
  }) => {
    await enterOpen(page);
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(page.getByRole("heading", { name: "Synthetic Store", exact: true })).toBeVisible();
    await page.evaluate(() => {
      history.pushState(null, "", "/menu");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const strip = page.getByRole("region", { name: "Store hours and address" });
    await expect(strip).toContainText("Open now · until 10:00 p.m. · last orders 9:30 p.m.");
    await expect(strip.getByRole("link", { name: "Holidays this week" })).toHaveAttribute(
      "href",
      "#store-info",
    );
    const info = page.getByRole("region", { name: "Synthetic Store" }).last();
    await expect(info).toContainText("Today 7:00 a.m.–10:00 p.m.");
    await expect(info).toContainText("Holidays and special hours this week");
    await expect(info).toContainText("Thursday, Dec 24 Special hours · 11:00 a.m.–4:00 p.m.");
    await expect(info).toContainText("Friday, Dec 25 Holiday · closed");
    await expect(info.getByRole("link", { name: /^Call / })).toHaveAttribute(
      "href",
      "tel:+15555550100",
    );
    await expectNoInternalText(page);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await info.screenshot({ path: `test-results/store-info-${width}.png` });
    }
    // In Chinese.
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(page.getByRole("region", { name: "营业时间和地址" })).toContainText(
      "厨房 21:30 停止接单",
    );
    await expect(info).toContainText("未来 7 天的节假日和特殊营业时间");
    await expect(info).toContainText("节假日 · 不营业");
    await page.setViewportSize({ width: 390, height: 844 });
    await info.screenshot({ path: "test-results/store-info-zh-390.png" });
  });

  test("a guest who scans on a holiday is told so and when the Store opens next", async ({
    page,
  }) => {
    await page.route("**/bff/customer/entry", (route) =>
      route.fulfill({
        status: 409,
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 1,
          code: "entry_not_accepting",
          messageKey: "customer.entry.not_accepting",
          recovery: { action: "TryLaterOrAskStaff", storeSelection: "Hidden" },
          store: {
            storeDisplayName: "Synthetic Store",
            operatingState: "Closed",
            todayHours: [],
            todayKind: "Holiday",
            nextOpening: { localDate: "2026-12-26", startLocalTime: "11:00:00" },
            localDate: "2026-12-25",
          },
        },
      }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#qr=aaa.bbb.ccc");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Synthetic Store isn’t taking orders right now");
    await expect(alert).toContainText("The store is closed today for a holiday.");
    await expect(alert).toContainText("Opens tomorrow at 11:00 a.m.");
    await expect(alert).not.toContainText("Closed today.");
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/entry-holiday-390.png", fullPage: true });
  });
});
