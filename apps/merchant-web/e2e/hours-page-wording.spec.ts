import { expect, test, type Page } from "@playwright/test";

/**
 * Batch 46 (v15 overnight hours check, Fireside Hotpot at 00:12 on Sun Nov 22): Hours & ordering
 * read "最后点单 30 分钟 打烊前" (English word order), "Updated Nov 22, 2026, 12:12 a.m." in an
 * English browser while the page was in Chinese, half-width "(…)" inside Chinese, a special date
 * 17 days past as "2026-11-05", and "5:00 PM–12:00 AM" where guests read "5:00 p.m.–12:00 a.m.".
 * The service read below is the shape v15 sent for that Store.
 */
const store = "018f8100-0000-7000-8000-000000000046";
const scope = { brandLabel: "Fireside Hotpot", storeLabel: "Main", storeReference: store };
const headers = { "cache-control": "no-store" };
const lunch = {
  startLocalTime: "11:30:00",
  endLocalTime: "14:30:00",
  endsNextDay: false,
  serviceModes: ["DineIn"],
  orderCutoffSeconds: 0,
  leadTimeSeconds: 0,
};
const dinner = {
  startLocalTime: "17:00:00",
  endLocalTime: "00:00:00",
  endsNextDay: true,
  serviceModes: ["DineIn"],
  orderCutoffSeconds: 1800,
  leadTimeSeconds: 900,
};
const lateNight = {
  ...dinner,
  startLocalTime: "00:00:00",
  endLocalTime: "03:00:00",
  endsNextDay: false,
};

async function open(page: Page, language: "en" | "zh-Hans") {
  // Batch 64: a date of this year is written without its year; the page reads as at the read.
  await page.clock.setFixedTime(new Date("2026-11-22T05:14:00.000Z"));
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      window.localStorage.setItem("bop.merchant.language", "zh-Hans");
    });
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
          storeStatus: "Closed",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [],
        },
      },
    }),
  );
  await page.route("**/merchant/store-configuration**", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "request_denied" } }),
  );
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({
      headers,
      json: {
        hours: {
          configurationSource: "StoreOverride",
          effectiveFrom: "2026-10-01T04:00:00.000Z",
          effectiveUntil: null,
          businessDayStartLocalTime: "04:00:00",
          weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
            isoWeekday: index + 1,
            intervals:
              index === 6 ? [{ ...lunch, orderCutoffSeconds: 1500 }, dinner] : [lunch, dinner],
          })),
          exceptions: [
            { localDate: "2026-11-05", kind: "Override", intervals: [lateNight, lunch, dinner] },
            { localDate: "2026-11-21", kind: "Override", intervals: [lunch, dinner] },
            { localDate: "2026-12-25", kind: "Holiday", intervals: [] },
          ],
        },
        screenId: "STORE-HOURS-SERVICE",
        storeReference: store,
        configurationReference: store,
        timeZone: "America/Toronto",
        enabledServiceModes: ["DineIn"],
        // 00:12 on Sun Nov 22 in Toronto: still Saturday's business day (it starts at 4:00).
        observedAt: "2026-11-22T05:12:00.000Z",
        expectedVersion: 3,
        activePauses: [
          {
            closureReference: "018f8100-0000-7000-8000-0000000000aa",
            effectiveFrom: "2026-11-22T05:10:00.000Z",
            effectiveUntil: "2026-11-22T05:40:00.000Z",
            serviceModes: null,
          },
        ],
      },
    }),
  );
  await page.goto("/app/organization/stores/" + store + "/service");
  await expect(page.locator("#published-hours-title")).toBeVisible();
}

const hoursText = (page: Page) =>
  page.locator("section[aria-labelledby='published-hours-title']").innerText();
const controlsText = (page: Page) =>
  page.locator("section[aria-labelledby='service-controls-title']").innerText();

async function fitsEveryWidth(page: Page, name: string) {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${name} ${width}`).toBeLessThanOrEqual(0);
    // Linux fonts (DejaVu) run wider than macOS ones: every line keeps about 40 px to spare.
    const tight = await page.evaluate(() =>
      [...document.querySelectorAll("main li, main p, main h2, main h3, main strong")]
        .filter((node) => (node as HTMLElement).offsetParent !== null)
        .filter((node) => node.getBoundingClientRect().right > window.innerWidth - 8)
        .map((node) => (node.textContent ?? "").slice(0, 40)),
    );
    expect(tight, `${name} ${width}`).toEqual([]);
    await page.screenshot({ path: `test-results/b46-${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("@production Hours & ordering reads on the staff 24-hour clock, today on, in English", async ({
  page,
}) => {
  await open(page, "en");
  const hours = await hoursText(page);
  expect(hours).toContain(
    "17:00–00:00 (next day) · Dine-in · last orders 30 minutes before closing · ready in 15 minutes",
  );
  expect(hours).toContain(
    "11:30–14:30 · Dine-in · last orders 25 minutes before closing",
  );
  // Batch 63 F54: the Store, its zone and business day are said once, under the page title.
  const head = await page.locator(".workspace-page__meta").innerText();
  expect(head).toBe(
    "Main · Eastern Time (Toronto, Ottawa and Montréal) · business day starts 04:00",
  );
  // Batch 64: the staff clock, never "a.m."/"p.m." (v15 b63: "Updated 12:32 p.m." here only).
  expect(hours).not.toMatch(/[ap]\.m\./u);
  expect(hours).not.toContain("Store configuration");
  // Past special dates are not listed; today's (the business day before 4:00) and later ones are.
  expect(hours).not.toContain("2026-11-05");
  expect(hours).not.toContain("Nov 5");
  expect(hours).toContain("Today · Sat, Nov 21 · Special hours");
  expect(hours).toContain("Fri, Dec 25 · Holiday");
  expect(hours).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
  expect(hours).not.toMatch(/\d (AM|PM)\b/u);
  const controls = await controlsText(page);
  // Batch 63 F54: the shared stamp at the top right; the zone is not said again here.
  await expect(page.locator(".workspace-page__status")).toHaveText("Updated 00:12");
  expect(controls).not.toContain("Eastern Time");
  expect(controls).toContain("All services — until Sun, Nov 22 00:40");
  expect(controls).not.toMatch(/\d (AM|PM)\b/u);
  await fitsEveryWidth(page, "hours-en");
});

test("@production Hours & ordering reads as natural Chinese, today on", async ({ page }) => {
  await open(page, "zh-Hans");
  const hours = await hoursText(page);
  expect(hours).toContain("17:00–00:00（次日）· 堂食 · 打烊前 30 分钟停止点单 · 预计 15 分钟做好");
  expect(hours).toContain("11:30–14:30 · 堂食 · 打烊前 25 分钟停止点单");
  const head = await page.locator(".workspace-page__meta").innerText();
  expect(head).toBe("Main · 北美东部时间（多伦多、渥太华和蒙特利尔）· 营业日从 04:00 开始");
  expect(hours).not.toContain("门店配置");
  expect(hours).not.toContain("最后点单");
  expect(hours).not.toMatch(/[^0-9]0:00/u);
  expect(hours).not.toMatch(/[一-鿿] \(|\) [一-鿿]|（[^）]*\(/u);
  expect(hours).not.toContain("） ·");
  expect(hours).not.toContain("2026-11-05");
  expect(hours).not.toContain("11月5日");
  expect(hours).toContain("今天 · 11月21日周六 · 特殊营业时间");
  expect(hours).toContain("12月25日周五 · 节假日");
  expect(hours).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
  expect(hours).not.toMatch(/[A-Za-z]/u);
  const controls = await controlsText(page);
  await expect(page.locator(".workspace-page__status")).toHaveText("已更新 00:12");
  expect(controls).not.toContain("北美东部时间");
  expect(controls).toContain("所有服务 — 至 11月22日周日 00:40");
  expect(controls).not.toMatch(/\b(?:Nov|a\.m\.|p\.m\.|AM|PM)\b/u);
  await fitsEveryWidth(page, "hours-zh");
});
