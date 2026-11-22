import { expect, test } from "@playwright/test";

/**
 * Batch 46 (v15 overnight 45): Test Merchant 2's published hours as v15 stores them, every day
 * 00:00–23:59:59 for Dine-in and Pickup with a 25-minute Sunday cut-off. Hours & ordering showed
 * "12:00 AM–11:59 PM" and "last orders 25 minutes before closing" for a Store that never closes.
 * Layout keeps about 40 px spare so Linux CI fonts (DejaVu) still fit.
 */
const store = "018f8100-0000-7000-8000-000000000046";
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: store,
};
const headers = { "cache-control": "no-store" };
const period = (isoWeekday: number) => ({
  startLocalTime: "00:00:00",
  endLocalTime: "23:59:59",
  endsNextDay: false,
  serviceModes: ["DineIn", "Pickup"],
  orderCutoffSeconds: isoWeekday === 7 ? 1500 : 0,
  leadTimeSeconds: 0,
});

for (const [language, locale] of [
  ["en", "en-CA"],
  ["zh-Hans", "zh-CN"],
] as const) {
  test.describe(`@production Hours & ordering for a Store open 24 hours (${language})`, () => {
    test.use({ locale });
    for (const width of [390, 1440]) {
      test(`says open 24 hours and when Sunday's orders stop at ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.route("**/merchant/session", (route) =>
          route.fulfill({
            headers,
            json: {
              authenticated: true,
              csrf: "a".repeat(43),
              workspace: {
                screenId: "HOME-OVERVIEW",
                selectedScope: scope,
                authorizedStores: [scope],
                businessDate: "2026-11-21",
                storeStatus: "Open",
                freshness: "Current",
                dashboardAvailability: "UnavailableUntilWP1905",
                navigation: [],
              },
            },
          }),
        );
        await page.route("**/merchant/service-control", (route) =>
          route.fulfill({
            headers,
            json: {
              hours: {
                configurationSource: "StoreOverride",
                effectiveFrom: "2026-11-01T00:00:00.000Z",
                effectiveUntil: null,
                businessDayStartLocalTime: "04:00:00",
                weeklySchedule: [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
                  isoWeekday,
                  intervals: [period(isoWeekday)],
                })),
                exceptions: [],
              },
              screenId: "STORE-HOURS-SERVICE",
              storeReference: store,
              configurationReference: store,
              timeZone: "America/Toronto",
              enabledServiceModes: ["DineIn", "Pickup"],
              observedAt: new Date().toISOString(),
              expectedVersion: 3,
              activePauses: [],
            },
          }),
        );
        await page.goto("/app/organization/stores/" + store + "/service");
        const zh = language === "zh-Hans";
        const hours = page.locator("section[aria-labelledby='published-hours-title']");
        await expect(
          hours.getByRole("heading", { name: zh ? "已发布的营业时间" : "Published hours" }),
        ).toBeVisible();
        const items = hours.locator(".detail-section-grid li");
        await expect(items).toHaveCount(7);
        await expect(items.first()).toHaveText(
          zh ? "24 小时营业 · 堂食、自取" : "Open 24 hours · Dine-in, Pickup",
        );
        await expect(items.last()).toHaveText(
          zh
            ? "24 小时营业 · 堂食、自取 · 23:34 后停止点单"
            : "Open 24 hours · Dine-in, Pickup · no orders after 11:34 p.m.",
        );
        await expect(hours).not.toContainText(zh ? "23:59" : "11:59");
        await expect(hours).not.toContainText(zh ? "打烊前" : "before closing");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        // The longest line still leaves about 40 px for wider fonts.
        const spare = await items.last().evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const rects = [...range.getClientRects()];
          return {
            lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
            spare: element.getBoundingClientRect().right - range.getBoundingClientRect().right,
          };
        });
        expect(spare.lines === 1 ? spare.spare : 40).toBeGreaterThanOrEqual(40);
        await page.screenshot({
          path: `test-results/b46-hours-all-day-${language}-${width}.png`,
          fullPage: true,
        });
      });
    }
  });
}
