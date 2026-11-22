import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads, syntheticStoreProfile } from "./storefront-reads";

test.beforeEach(({ context }) => routeStorefrontReads(context));

/**
 * Batch 46 (v15 overnight 45), with the store reads seen live:
 * (1) Test Merchant 2 publishes 00:00–23:59:59 every day; guests read "Open now · until 11:59 p.m."
 *     and "Today 12:00 a.m.–11:59 p.m." for a Store that never closes.
 * (2) zh sentences spaced a Store's name three ways ("已选择在 巷口糖水 Lane Dessert (TEST) 自取。",
 *     "… (TEST) 现在不接单" joined in code, "…(TEST)只做堂食"); now the staff screens' rule (b12):
 *     a Chinese name meets Chinese directly, Latin letters or digits get one space.
 * (3) "今天营业至 1:00" rendered as "今天 营业至" because a margin undid the no-gap rule.
 * Layout checks keep about 40 px spare so Linux CI fonts (DejaVu) still fit.
 */
const id = (n: number) => "018f8a46-0000-7000-8000-" + n.toString(16).padStart(12, "0");

const allDayHours = {
  status: "Open",
  todayHours: [{ startLocalTime: "00:00:00", endLocalTime: "23:59:59", endsNextDay: false }],
  closesAt: "23:59:59",
  opensAt: null,
  localDate: "2026-11-22",
  todayKind: null,
  lastOrdersAt: "23:34:59",
  pausedUntil: null,
  ordersStopped: false,
  nextOpening: null,
  tonight: null,
  upcoming: [],
};
const dessertAfterMidnight = {
  status: "Open",
  todayHours: [{ startLocalTime: "12:00:00", endLocalTime: "01:00:00", endsNextDay: true }],
  closesAt: "01:00:00",
  opensAt: null,
  localDate: "2026-11-22",
  todayKind: null,
  lastOrdersAt: "00:30:00",
  pausedUntil: null,
  ordersStopped: false,
  nextOpening: null,
  tonight: { startLocalTime: "12:00:00", endLocalTime: "01:00:00" },
  upcoming: [],
};

async function storeRead(page: Page, storeDisplayName: string, hours: Record<string, unknown>) {
  await page.route("**/api/v1/customer/store", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "private, max-age=30" },
      json: {
        ...syntheticStoreProfile,
        store: { ...syntheticStoreProfile.store, storeDisplayName, hours },
      },
    }),
  );
}

async function enterPickup(page: Page, storeDisplayName: string) {
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName,
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
  await page.goto("/#qr=aaa.bbb.ccc");
}

async function toMenu(page: Page) {
  await page.evaluate(() => {
    history.pushState(null, "", "/menu");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/** A line that never wraps keeps about 40 px spare for wider Linux fonts. */
async function fitsWithMargin(page: Page, selector: string) {
  await noSidewaysScroll(page);
  const spare = await page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return Math.min(box.right, window.innerWidth) - text.right;
    });
  expect(spare).toBeGreaterThanOrEqual(40);
}

for (const [language, locale] of [
  ["en", "en-CA"],
  ["zh-Hans", "zh-CN"],
] as const) {
  test.describe(`@production batch 46 guest hours and names (${language})`, () => {
    test.use({ serviceWorkers: "block", locale });
    const zh = language === "zh-Hans";

    for (const width of [390, 1440]) {
      test(`a Store open 24 hours says so on the start page and the menu at ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const name = "Test Merchant 2 Main - not production";
        await storeRead(page, name, allDayHours);
        await enterPickup(page, name);
        const card = page.getByRole("region", { name }).first();
        await expect(card).toContainText(
          zh
            ? "今天 24 小时营业 · 厨房 23:34 停止接单"
            : "Open 24 hours today · last orders 11:34 p.m.",
        );
        await expect(card).toContainText(zh ? "今天 24 小时营业" : "Today open 24 hours");
        await expect(card).not.toContainText(zh ? "23:59" : "11:59");
        await expect(card).not.toContainText(zh ? "营业至" : "until");
        await noSidewaysScroll(page);
        await toMenu(page);
        const strip = page.getByRole("region", {
          name: zh ? "营业时间和地址" : "Store hours and address",
        });
        await expect(strip).toContainText(zh ? "今天 24 小时营业" : "Open 24 hours today");
        await expect(strip).toContainText(zh ? "厨房 23:34 停止接单" : "Last orders 11:34 p.m.");
        await expect(strip).not.toContainText(zh ? "23:59" : "11:59");
        await fitsWithMargin(page, ".store-strip__line");
        const info = page.locator("#store-info");
        await expect(info).toContainText(zh ? "今天 24 小时营业" : "Today open 24 hours");
        await expectNoInternalText(page);
        await page.screenshot({ path: `test-results/b46-all-day-${language}-${width}.png` });
      });
    }

    test("after a 24-hour day's last orders, the guest is told when ordering opens again", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const name = "Test Merchant 2 Main - not production";
      await storeRead(page, name, {
        ...allDayHours,
        ordersStopped: true,
        nextOpening: { localDate: "2026-11-23", startLocalTime: "00:00:00" },
      });
      await enterPickup(page, name);
      const notice = page.locator(".entry-state__next");
      await expect(notice).toHaveText(
        zh ? "明天 0:00 起可以再点单。" : "You can order again tomorrow at 12:00 a.m.",
      );
      await expect(page.locator("main")).not.toContainText(zh ? "23:59 打烊" : "closes at 11:59");
      await noSidewaysScroll(page);
    });

    test("the gap after Today is the text's own: none before Chinese words, a space in English", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const name = "巷口糖水 Lane Dessert (TEST)";
      await storeRead(page, name, dessertAfterMidnight);
      await enterPickup(page, name);
      const hours = page.locator(".store-identity__hours").first();
      await expect(hours).toHaveText(
        zh
          ? "今天营业至 1:00，之后 12:00–1:00（次日）"
          : "Today until 1:00 a.m., then 12:00 p.m.–1:00 a.m. (next day)",
      );
      const gap = await hours.evaluate((element) => {
        const label = element.querySelector("span");
        if (label === null) return -1;
        // The first visible character after the label, whichever text node holds it.
        let node = label.nextSibling;
        while (node !== null && (node.textContent ?? "").trim() === "") node = node.nextSibling;
        if (node === null) return -1;
        const at = (node.textContent ?? "").search(/\S/u);
        const glyph = document.createRange();
        glyph.setStart(node, at);
        glyph.setEnd(node, at + 1);
        return glyph.getBoundingClientRect().left - label.getBoundingClientRect().right;
      });
      if (zh) expect(gap).toBeLessThan(1);
      else expect(gap).toBeGreaterThan(2);
      // Pickup is said with the Store's name set off where its Latin letters meet Chinese.
      await expect(page.locator(".entry-context").first()).toHaveText(
        zh
          ? "已选择在巷口糖水 Lane Dessert (TEST) 自取。"
          : "Pickup from 巷口糖水 Lane Dessert (TEST) is selected.",
      );
      await noSidewaysScroll(page);
    });

    for (const width of [390, 1440]) {
      test(`a closed Store's heading is one sentence around its name at ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
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
                storeDisplayName: "半糖奶茶 Half Sugar Tea (TEST)",
                operatingState: "Closed",
                todayHours: [
                  { startLocalTime: "11:00:00", endLocalTime: "23:00:00", endsNextDay: false },
                ],
                todayKind: null,
                nextOpening: { localDate: "2026-11-23", startLocalTime: "11:00:00" },
                localDate: "2026-11-22",
              },
            },
          }),
        );
        await page.goto("/#qr=aaa.bbb.ccc");
        const heading = page.locator("#entry-heading");
        await expect(heading).toHaveText(
          zh
            ? "半糖奶茶 Half Sugar Tea (TEST) 现在不接单"
            : "半糖奶茶 Half Sugar Tea (TEST) isn’t taking orders right now",
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({ path: `test-results/b46-closed-name-${language}-${width}.png` });
      });
    }
  });
}
