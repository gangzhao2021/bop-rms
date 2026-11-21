import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads, syntheticStoreProfile } from "./storefront-reads";

// Batch 40 (v15 cross-midnight check, 2026-11-21). Synthetic HTTP answers on the production PWA,
// shaped as the Store read seen live at Lane Dessert: open 12:00 p.m.–1:00 a.m. with last orders
// 12:30 a.m., read at 12:31 a.m. on the next date. The clock is fixed, so nothing depends on the
// time of day the suite runs.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block", trace: "off", video: "off" });

const id = (n: number) => "018f8a40-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = new Date("2026-11-21T05:31:00.000Z");
const asciiInChinese = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]\.(?!\.)/u;
const stoppedHours = {
  status: "Open",
  todayHours: [{ startLocalTime: "12:00:00", endLocalTime: "01:00:00", endsNextDay: true }],
  closesAt: "01:00:00",
  opensAt: null,
  localDate: "2026-11-21",
  todayKind: null,
  lastOrdersAt: "00:30:00",
  pausedUntil: null,
  ordersStopped: true,
  nextOpening: { localDate: "2026-11-21", startLocalTime: "12:00:00" },
  tonight: { startLocalTime: "12:00:00", endLocalTime: "01:00:00" },
  upcoming: [],
};

async function storeRead(page: Page, hours: Record<string, unknown>) {
  await page.route("**/api/v1/customer/store", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "private, max-age=30" },
      json: { ...syntheticStoreProfile, store: { ...syntheticStoreProfile.store, hours } },
    }),
  );
}

async function enter(page: Page, channel: "Pickup" | "DineIn") {
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
        publicTableReference: channel === "DineIn" ? id(7) : null,
        channel,
        operatingState: "Open",
        availableServiceModes: [channel],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: "h".repeat(43),
      },
    }),
  );
}

async function fitsAt(page: Page, width: number, name: string) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: `test-results/b40-${name}-${width}.png`, fullPage: true });
}

test.describe("@production after last orders and after midnight", () => {
  test("a pickup guest after last orders is told the kitchen stopped, closing and opening, menu only", async ({
    page,
  }) => {
    await page.clock.setFixedTime(at);
    await storeRead(page, stoppedHours);
    await enter(page, "Pickup");
    await page.goto("/#qr=aaa.bbb.ccc");
    const card = page.locator(".entry-card");
    await expect(
      card.getByRole("heading", { name: "The kitchen has stopped taking orders" }),
    ).toBeVisible();
    await expect(card).toContainText(
      "The kitchen stopped taking orders at 12:30 a.m. You can’t place a pickup order from your phone now.",
    );
    await expect(card).toContainText(
      "The store closes at 1:00 a.m. and opens again today at 12:00 p.m.",
    );
    await expect(card).not.toContainText("Ready to order");
    await expect(page.getByRole("button", { name: "Continue to menu" })).toHaveCount(0);
    // After midnight the hours line names the current period by its end, then today's hours.
    const info = page.getByRole("region", { name: "Synthetic Store" }).last();
    await expect(info).toContainText("Today until 1:00 a.m., then 12:00 p.m.–1:00 a.m. (next day)");
    await expect(info).not.toContainText("Tonight");
    await expectNoInternalText(page);
    for (const width of [390, 1440]) await fitsAt(page, width, "pickup-stopped-en");

    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(card.getByRole("heading", { name: "厨房已停止接单" })).toBeVisible();
    await expect(card).toContainText("厨房 0:30 已停止接单。现在不能用手机下自取单。");
    await expect(card).toContainText("门店 1:00 打烊，今天 12:00 再开门。");
    await expect(card).not.toContainText("可以开始点单");
    await expect(info).toContainText("今天 营业至 1:00，之后 12:00–1:00（次日）");
    await expect(info).not.toContainText("今晚");
    expect(await page.locator("main").innerText()).not.toMatch(asciiInChinese);
    for (const width of [390, 1440]) await fitsAt(page, width, "pickup-stopped-zh");

    // The one way on is the menu, to look at; it says the stop once, with Chinese punctuation.
    await page.getByRole("button", { name: "看看菜单" }).click();
    await expect(page).toHaveURL(/\/menu$/u);
    const notice = page.getByRole("alert", { name: "停止接单" });
    await expect(notice).toHaveText("厨房 0:30 已停止接单。现在不能用手机下自取单。");
    // The status strip just above the notice no longer says it a second time (the Store's own
    // facts at the end of the menu still list it once with its hours).
    const strip = page.getByRole("region", { name: "营业时间和地址" });
    await expect(strip).toContainText("营业中 · 营业至 1:00");
    await expect(strip).not.toContainText("停止接单");
    expect(await page.locator("main").innerText()).not.toMatch(asciiInChinese);
    await page.getByRole("button", { name: "Switch to English" }).click();
    await expect(page.getByRole("region", { name: "Store hours and address" })).not.toContainText(
      "stopped taking orders",
    );
    await expect(page.getByRole("alert", { name: "Last orders" })).toHaveText(
      "The kitchen stopped taking orders at 12:30 a.m. You can’t place a pickup order from your phone now.",
    );
    for (const width of [390, 1440]) await fitsAt(page, width, "menu-stopped");
  });

  test("at a table after last orders the guest is told the kitchen stopped and to ask staff", async ({
    page,
  }) => {
    await page.clock.setFixedTime(at);
    await storeRead(page, stoppedHours);
    await enter(page, "DineIn");
    await page.goto("/#qr=aaa.bbb.ccc");
    const card = page.locator(".entry-card");
    await expect(card).toContainText(
      "The kitchen stopped taking orders at 12:30 a.m. You can’t send a new order from your phone now. To add something, ask a staff member.",
    );
    for (const width of [390, 1440]) await fitsAt(page, width, "table-stopped-en");
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(card).toContainText("厨房 0:30 已停止接单。");
    expect(await card.innerText()).not.toMatch(asciiInChinese);
    for (const width of [390, 1440]) await fitsAt(page, width, "table-stopped-zh");
  });

  test("before last orders the pickup start is unchanged", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-21T04:00:00.000Z"));
    await storeRead(page, {
      ...stoppedHours,
      ordersStopped: false,
      nextOpening: null,
      tonight: null,
      localDate: "2026-11-20",
    });
    await enter(page, "Pickup");
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(page.getByRole("heading", { name: "Ready to order" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to menu" })).toBeVisible();
    await expect(page.getByText("stopped taking orders")).toHaveCount(0);
  });

  test("a closed Store says when it opens in a Chinese sentence that ends with “。”", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-11-21T06:10:00.000Z"));
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
            todayHours: stoppedHours.todayHours,
            todayKind: null,
            nextOpening: { localDate: "2026-11-21", startLocalTime: "12:00:00" },
            localDate: "2026-11-21",
          },
        },
      }),
    );
    await page.goto("/#qr=aaa.bbb.ccc");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Opens today at 12:00 p.m.");
    await expect(alert).not.toContainText("p.m..");
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(alert).toContainText("今天 12:00 开门。");
    expect(await alert.innerText()).not.toMatch(asciiInChinese);
    for (const width of [390, 1440]) await fitsAt(page, width, "closed-zh");
  });
});
