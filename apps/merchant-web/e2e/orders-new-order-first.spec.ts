import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 55 (v15 batch 54 live, Test Merchant 2): 46 pickups from earlier business days were still
 * open, and a New order waiting to be accepted sat about 15,000 px down Orders on a phone while the
 * header said "1 to accept". The earlier days' orders led the list, and "Needs attention" listed
 * every one of them above it. A New order staff must accept is now on the first screen at every
 * width: today's orders come first (the ones to accept on top), the earlier days' unfinished
 * orders follow under their own heading, and "Needs attention" sums them up in one line that opens,
 * as the kitchen display does. Every order stays listed. Synthetic HTTP interception, TEST-only
 * data, in the shape v15 answers (earlier-day open pickups in earlierDayItems, today's in items,
 * newest first).
 */
const id = (n: number) => "0190b155-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const today = "2026-11-23";
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(999),
  timeZone: "America/Toronto",
};
const session = {
  authenticated: true,
  csrf: "a".repeat(43),
  workspace: {
    screenId: "HOME-OVERVIEW",
    selectedScope: scope,
    authorizedStores: [scope],
    businessDate: today,
    storeStatus: "Open",
    freshness: "Current",
    dashboardAvailability: "UnavailableUntilWP1905",
    navigation: [
      {
        screenId: "OPS-ORDER-QUEUE",
        label: "Orders",
        href: "/operations/orders",
        permission: "ordering.operate",
      },
    ],
  },
};
const order = (
  n: number,
  orderNumber: string,
  businessDate: string,
  submittedAt: string,
  awaiting: boolean,
) => ({
  orderReference: id(n),
  orderNumber,
  orderType: "Pickup",
  sourceChannel: "Web",
  businessDate,
  listedBusinessDate: businessDate,
  heldStock: null,
  earlierOpenPickup: businessDate !== today,
  submittedAt,
  observedAt: submittedAt,
  initialBatchReference: id(1000 + n),
  batches: [
    {
      orderBatchReference: id(1000 + n),
      sequence: 1,
      acceptanceStatus: awaiting ? "NotAccepted" : "Accepted",
      canRequestAcceptance: awaiting,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: awaiting,
  currentPhase: awaiting ? "Submitted" : "Accepted",
  currentVersion: awaiting ? 1 : 2,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: awaiting ? new Date(Date.now() + 30 * 60_000).toISOString() : null,
  awaitingPayment: false,
});
// v15 TM2 at the batch 54 check: 46 earlier-day open pickups (11/4 to 11/12) and a full page of
// today's (the server answers at most 50 a page).
const earlierDays = ["2026-11-04", "2026-11-05", "2026-11-11", "2026-11-12"];
const earlierDayItems = Array.from({ length: 46 }, (_, i) => {
  const day = earlierDays[i % earlierDays.length] as string;
  return order(100 + i, String(20 + i * 3), day, day + "T21:33:01.000Z", false);
});
const todaysAccepted = (now: number) =>
  Array.from({ length: 49 }, (_, i) =>
    order(300 + i, String(i + 1), today, new Date(now - (60 - i) * 60_000).toISOString(), false),
  ).reverse();

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const)
    test(`@production a New order to accept is on the first screen past many earlier-day orders, ${language} at ${width}`, async ({
      page,
    }) => {
      if (language === "zh-Hans")
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      await page.clock.install();
      const now = Date.now();
      let items = todaysAccepted(now);
      await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
      await page.route("**/merchant/business-day", (route) =>
        route.fulfill({
          headers,
          json: {
            businessDate: today,
            startsAt: new Date(now - 6 * 3_600_000).toISOString(),
            endsAt: new Date(now + 18 * 3_600_000).toISOString(),
            timeZone: "America/Toronto",
            observedAt: new Date(now).toISOString(),
          },
        }),
      );
      for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
        await page.route(pattern, (route) =>
          route.fulfill({
            headers,
            json: { earlierDayItems, items, nextAfterOrderReference: null },
          }),
        );
      await page.goto("/operations/orders");
      const rows = page.locator("li.order-row:not([hidden])");
      await expect(rows).toHaveCount(95);
      // The New order arrives while staff have Orders open, as at v15.
      items = [order(900, "51", today, new Date(now).toISOString(), true), ...items];
      await page.clock.fastForward(11_000);
      await expect(rows).toHaveCount(96);
      const fresh = page.locator("li.order-row[data-new]");
      await expect(fresh).toHaveCount(1);
      await expect(fresh.locator(".order-row__open")).toContainText("51");
      await expect(page.locator(".workspace-page__meta")).toContainText(
        language === "en" ? "1 to accept" : "1 单待接",
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      const box = await fresh.evaluate((row) => {
        const rect = row.getBoundingClientRect();
        return { top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY };
      });
      // On the first screen, with room for wider Linux fonts (DejaVu Sans) above it.
      expect(box.bottom, JSON.stringify(box)).toBeLessThanOrEqual(height - 40);
      // The "New order" mark never runs into what the order is (1024/1440 put it under "51").
      const mark = await fresh.evaluate((row) => {
        const word = row.querySelector(".order-row__new")?.getBoundingClientRect();
        // Batch 63 (F19): the dishes are their own cell beside the number (Figma 37:2).
        const what = row.querySelector(".order-workbench-type")?.getBoundingClientRect();
        const status = row.querySelector(".order-row__status")?.getBoundingClientRect();
        return {
          right: word?.right ?? 0,
          bottom: word?.bottom ?? 0,
          whatLeft: what?.left ?? 0,
          whatTop: what?.top ?? 0,
          statusTop: status?.top ?? 0,
        };
      });
      expect(
        mark.right <= mark.whatLeft - 8 ||
          mark.bottom <= Math.min(mark.whatTop, mark.statusTop) + 1,
        JSON.stringify(mark),
      ).toBe(true);
      // Every order stays listed: today's first, then the earlier days' under their own heading.
      const order_ = await rows.evaluateAll((list) =>
        list.map((row) => row.querySelector(".order-row__open")?.textContent ?? ""),
      );
      expect(order_[0]).toContain("51");
      const firstEarlier = order_.findIndex((label) => label.includes("/"));
      expect(firstEarlier).toBe(50);
      expect(order_.slice(firstEarlier).every((label) => label.includes("/"))).toBe(true);
      await expect(
        page.getByRole("heading", {
          name: language === "en" ? "Earlier days · not finished" : "较早营业日 · 未完成",
        }),
      ).toHaveCount(1);
      // "Needs attention" still names the earlier days' orders, in one line that opens.
      const attention = page.locator(".order-attention");
      await expect(attention).toContainText(
        language === "en"
          ? "46 orders from earlier days aren't finished"
          : "46 张较早营业日的订单还没有完成",
      );
      const showOne = language === "en" ? "Show order 11/4 · 20" : "查看 11/4 · 20 号单";
      await expect(attention.getByRole("button", { name: showOne })).toBeHidden();
      await page.screenshot({
        path: test.info().outputPath(`orders-new-first-${language}-${width}.png`),
      });
      await attention.locator("summary").click();
      await expect(attention.getByRole("button", { name: showOne })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      await page.screenshot({
        path: test.info().outputPath(`orders-new-first-${language}-${width}-opened.png`),
        fullPage: true,
      });
      await expectNoInternalText(page);
    });

/**
 * Batch 56 (v15 batch 55 live, Test Merchant 2 at 390 en): the header said "51 orders today" (the
 * page's 50 plus a 19-day-old table order) while the Store had 74 orders that business day; the
 * table order "11/4 · 2", whose only round from Wed Nov 4 was still waiting to be accepted, was
 * listed first under "Today", above the real New order, and the New order had 9 px to spare on a
 * phone's first screen. The header counts the day's orders as the server counts them; an
 * earlier-day order still waiting sits with the earlier days' unfinished orders (Needs attention
 * names it, the To accept tab still lists it, its row says so), never dropped; and the New order
 * keeps room on the first screen with sound off, Pause ordering and Needs attention above it.
 */
const tm2Table = {
  orderReference: id(90),
  orderNumber: "2",
  orderType: "DineIn",
  sourceChannel: "Qr",
  businessDate: "2026-11-04",
  listedBusinessDate: today,
  heldStock: null,
  earlierOpenPickup: false,
  submittedAt: "2026-11-05T01:47:04.758Z",
  observedAt: "2026-11-23T05:00:00.000Z",
  initialBatchReference: id(1090),
  batches: [
    {
      orderBatchReference: id(1090),
      sequence: 1,
      acceptanceStatus: "NotAccepted",
      canRequestAcceptance: true,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
      submittedAt: "2026-11-05T01:47:04.758Z",
    },
  ],
  canRequestAcceptance: true,
  tableBill: { totalMinor: "2825", paid: null },
  currentPhase: "Submitted",
  currentVersion: 1,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
};
// v15 TM2 at the batch 55 check: 45 earlier-day open pickups (11/4 to 11/13) after the table.
const tm2Earlier = [
  tm2Table,
  ...Array.from({ length: 45 }, (_, i) => {
    const day = earlierDays[i % earlierDays.length] as string;
    return order(100 + i, String(20 + i * 3), day, day + "T21:33:01.000Z", false);
  }),
];
for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const)
    test(`@production Orders counts the day's orders and keeps an earlier-day order to accept with the earlier days, ${language} at ${width}`, async ({
      page,
    }) => {
      const en = language === "en";
      if (!en)
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      await page.clock.install();
      const now = Date.now();
      // A full page of today's 50 newest, with 24 more of today's behind Next page.
      const todays = Array.from({ length: 51 }, (_, i) =>
        order(
          300 + i,
          String(i + 1),
          today,
          new Date(now - (60 - i) * 60_000).toISOString(),
          false,
        ),
      ).reverse();
      let answer = {
        earlierDayItems: tm2Earlier,
        items: todays.slice(0, 50),
        nextAfterOrderReference: id(301),
        todayOrderCount: 74,
      };
      await page.route("**/merchant/session", (route) =>
        route.fulfill({
          headers,
          json: { ...session, workspace: { ...session.workspace, pauseOrderingShown: true } },
        }),
      );
      await page.route("**/merchant/business-day", (route) =>
        route.fulfill({
          headers,
          json: {
            businessDate: today,
            startsAt: new Date(now - 6 * 3_600_000).toISOString(),
            endsAt: new Date(now + 18 * 3_600_000).toISOString(),
            timeZone: "America/Toronto",
            observedAt: new Date(now).toISOString(),
          },
        }),
      );
      await page.route("**/merchant/service-control", (route) =>
        route.fulfill({
          headers,
          json: {
            hours: {
              configurationSource: "StoreOverride",
              effectiveFrom: "2026-07-29T11:00:00.000Z",
              effectiveUntil: null,
              businessDayStartLocalTime: "04:00:00",
              weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
                isoWeekday: index + 1,
                intervals: [],
              })),
              exceptions: [],
            },
            screenId: "STORE-HOURS-SERVICE",
            storeReference: scope.storeReference,
            configurationReference: id(70),
            timeZone: scope.timeZone,
            enabledServiceModes: ["DineIn", "Pickup"],
            observedAt: new Date(now).toISOString(),
            expectedVersion: 4,
            activePauses: [],
          },
        }),
      );
      for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
        await page.route(pattern, (route) => route.fulfill({ headers, json: answer }));
      await page.goto("/operations/orders");
      const rows = page.locator("li.order-row:not([hidden])");
      await expect(rows).toHaveCount(96);
      // The New order arrives while staff have Orders open; the oldest of today's moves to page 2.
      answer = {
        ...answer,
        items: [order(900, "75", today, new Date(now).toISOString(), true), ...todays.slice(0, 49)],
        nextAfterOrderReference: id(302),
        todayOrderCount: 75,
      };
      await page.clock.fastForward(11_000);
      const fresh = page.locator("li.order-row[data-new]");
      await expect(fresh).toHaveCount(1);
      const meta = page.locator(".workspace-page__meta");
      // The day's count is the server's, not the page's (and not the 19-day-old table order).
      await expect(meta).toContainText(en ? "75 orders today" : "今天 75 单");
      // Batch 57: today's New order and the earlier days' table order, each in its own part.
      await expect(meta).toHaveText(
        en
          ? "75 orders today · 1 to accept · 46 from earlier days (1 to accept)"
          : "今天 75 单 · 1 单待接 · 另有 46 单来自较早营业日（1 单待接）",
      );
      await expect(
        page.getByRole("button", { name: en ? "Pause ordering" : "暂停点单" }),
      ).toBeVisible();
      const notice = page.locator(".order-sound-notice");
      await expect(notice).toBeVisible();
      // On a phone the sound notice and its button share one line (it took three before).
      if (width < 768) {
        const line = await notice.boundingBox();
        const button = await notice.getByRole("button").boundingBox();
        expect(line?.height ?? 0, "sound notice on one line").toBeLessThanOrEqual(
          (button?.height ?? 0) + 8,
        );
      }
      // The New order is the first row, with room on the first screen for Linux fonts.
      const labels = await rows.evaluateAll((list) =>
        list.map((row) => row.querySelector(".order-row__open")?.textContent ?? ""),
      );
      expect(labels[0]).toContain("75");
      await page.evaluate(() => window.scrollTo(0, 0));
      const bottom = await fresh.evaluate(
        (row) => row.getBoundingClientRect().bottom + window.scrollY,
      );
      test.info().annotations.push({ type: "bottom", description: `${bottom} of ${height}` });
      expect(bottom, `${language} ${width}`).toBeLessThanOrEqual(height - 40);
      // The table order still waiting from 11/4 is with the earlier days, says so, and is kept.
      const table = rows.filter({ hasText: /11\/4 · 2(?!\d)/u });
      await expect(table).toHaveCount(1);
      const tableIndex = labels.findIndex((label) => /11\/4 · 2(?!\d)/u.test(label));
      expect(tableIndex).toBeGreaterThanOrEqual(50);
      await expect(table).toContainText(
        en ? "From an earlier day · waiting to be accepted" : "较早营业日 · 待接单",
      );
      await expect(table.getByRole("button", { name: en ? /^Accept/u : /^接单/u })).toHaveCount(1);
      const attention = page.locator(".order-attention");
      await expect(attention).toContainText(
        en ? "46 orders from earlier days aren't finished" : "46 张较早营业日的订单还没有完成",
      );
      await page.screenshot({
        path: test.info().outputPath(`orders-tm2-${language}-${width}.png`),
      });
      await attention.locator("summary").click();
      await expect(
        attention.getByRole("button", {
          name: en ? "Show order 11/4 · 2" : "查看 11/4 · 2 号单",
          exact: true,
        }),
      ).toBeVisible();
      // One tap away on To accept, with today's New order first.
      await page
        .locator(".order-status-filters button")
        .filter({ hasText: en ? "To accept" : "待接单" })
        .click();
      const accepting = await rows.evaluateAll((list) =>
        list.map((row) => row.querySelector(".order-row__open")?.textContent ?? ""),
      );
      expect(accepting).toHaveLength(2);
      expect(accepting[0]).toContain("75");
      expect(accepting[1]).toContain("11/4 · 2");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      await expectNoInternalText(page);
    });

/**
 * Batch 57 (v15 batch 56 live, Test Merchant 2, business date 2026-11-23, 89 then 100 orders
 * that day): the header read "89 orders today · 1 to accept · 46 from earlier days" while the one
 * order to accept was the 11/4 table order listed under the earlier days, as if one of today's 89
 * still waited. The status tabs under it read "All 96 · To accept 1 · In progress 41 · Ready 5 ·
 * Picked up / served 49": the loaded rows (50 of today's plus the 46 earlier-day ones), neither
 * today's count nor today's plus the earlier days'. In zh-Hans the same earlier-day group was
 * named four ways (之前营业日 · 还没做完 / 之前营业日的单 · 还没接 / 较早营业日 · 未完成 / 另有 46 单是之前的).
 * The header now says which group the order to accept is in; "All" counts today's orders (the
 * server's count) plus the earlier days' listed with them; a tab whose rows are only partly loaded
 * shows no number that could pass for the day's; zh-Hans names the group 较早营业日 throughout.
 * Every order stays listed.
 */
for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const)
    test(`@production Orders header and tabs count what they say with a day bigger than one page, ${language} at ${width}`, async ({
      page,
    }) => {
      const en = language === "en";
      if (!en)
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      await page.clock.install();
      const now = Date.now();
      // Today's newest 50 of 89 (none waiting): 41 being made, 5 ready, 4 picked up.
      const todays = Array.from({ length: 50 }, (_, i) => {
        const row = order(
          349 - i,
          String(89 - i),
          today,
          new Date(now - (i + 1) * 4 * 60_000).toISOString(),
          false,
        );
        return i < 41
          ? row
          : i < 46
            ? { ...row, kitchenPhase: "Ready" }
            : { ...row, currentPhase: "Fulfilled", currentVersion: 3 };
      });
      const answer = {
        earlierDayItems: tm2Earlier,
        items: todays,
        nextAfterOrderReference: id(300),
        todayOrderCount: 89,
      };
      await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
      await page.route("**/merchant/business-day", (route) =>
        route.fulfill({
          headers,
          json: {
            businessDate: today,
            startsAt: new Date(now - 20 * 3_600_000).toISOString(),
            endsAt: new Date(now + 4 * 3_600_000).toISOString(),
            timeZone: "America/Toronto",
            observedAt: new Date(now).toISOString(),
          },
        }),
      );
      for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
        await page.route(pattern, (route) => route.fulfill({ headers, json: answer }));
      await page.goto("/operations/orders");
      const rows = page.locator("li.order-row:not([hidden])");
      await expect(rows).toHaveCount(96);
      const meta = page.locator(".workspace-page__meta");
      // The one to accept is the earlier days' table order, and the header says so.
      await expect(meta).toHaveText(
        en
          ? "89 orders today · 46 from earlier days (1 to accept)"
          : "今天 89 单 · 另有 46 单来自较早营业日（1 单待接）",
      );
      // "All": today's 89 (the server's count) and the 46 earlier-day orders listed with them.
      const tabs = page.locator(".order-status-filters button");
      const tab = (name: string) => tabs.filter({ hasText: name });
      await expect(tab(en ? "All" : "全部").locator(".order-status-filters__count")).toHaveText(
        "135",
      );
      // Batch 63 (F21): "To accept" says the header's count (the orders waiting are listed first).
      await expect(page.locator(".workspace-page__meta")).toContainText(
        en ? "1 to accept" : "1 单待接",
      );
      await expect(
        tab(en ? "To accept" : "待接单").locator(".order-status-filters__count"),
      ).toHaveText("1");
      // The other tabs' rows are partly on the next page: no number that reads as the day's.
      for (const name of en
        ? ["In progress", "Ready", "Picked up / served"]
        : ["进行中", "已做好", "已取餐/上桌"])
        await expect(tab(name).locator(".order-status-filters__count"), name).toHaveCount(0);
      // One name for the earlier days' group in Chinese: heading, row tags, Needs attention.
      const list = page.locator(".order-workbench");
      if (!en) {
        await expect(list).toContainText("较早营业日 · 未完成");
        const table = rows.filter({ hasText: /11\/4 · 2(?!\d)/u });
        await expect(table).toContainText("较早营业日 · 待接单");
        await expect(page.locator(".order-attention")).toContainText(
          "46 张较早营业日的订单还没有完成",
        );
        const text = (await page.locator("body").innerText()).replaceAll(/\s+/gu, "");
        expect(text).not.toContain("之前营业日");
        expect(text).not.toContain("是之前的");
        expect(text).not.toContain("还没接");
      }
      // The header line and the tabs fit with room to spare for Linux fonts.
      const fits = await page.evaluate(() => {
        const right = document.documentElement.clientWidth;
        return [".workspace-page__meta", ".order-status-filters"].map((selector) => {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          return box === undefined ? -1 : right - box.right;
        });
      });
      for (const spare of fits) expect(spare).toBeGreaterThanOrEqual(0);
      // Today's newest order is still on the first screen under the longer header line.
      await page.evaluate(() => window.scrollTo(0, 0));
      const first = await rows
        .first()
        .evaluate((row) => row.getBoundingClientRect().bottom + window.scrollY);
      expect(first, `${language} ${width}`).toBeLessThanOrEqual(height - 40);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      await page.screenshot({
        path: test.info().outputPath(`orders-counts-${language}-${width}.png`),
      });
      // The To accept tab still lists the earlier days' order (never hidden).
      await tab(en ? "To accept" : "待接单").click();
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("11/4 · 2");
      await expectNoInternalText(page);
    });

/**
 * Batch 58 (v15 batch 57 live, Test Merchant 2 at 04:06 Toronto, business date 2026-11-24, 104
 * orders the day before): the first page held today's 3 orders and 47 of yesterday's finished
 * ones, with 46 earlier-day orders listed after them and a next page. Today listed 49 rows and All
 * said 49, but with To accept chosen the footer read "2 of 96 orders on this page match" (zh 本页
 * 96 笔订单中有 1 笔符合): it counted yesterday's rows that Today hides. At 390 the header wrapped
 * inside the parenthesis, "46 from earlier days (1 to" / "accept)" and "（1 单待" / "接）". The
 * footer now counts the rows Today shows, the same as All, and each count phrase of the header
 * stays on one line. The answer is the live shape, with synthetic references.
 */
const liveToday = "2026-11-24";
const liveYesterday = "2026-11-23";
for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const)
    test(`@production the Orders footer counts what Today shows and the header keeps each count whole, ${language} at ${width}`, async ({
      page,
    }) => {
      const en = language === "en";
      if (!en)
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      await page.clock.install();
      const now = Date.now();
      const listed = (row: ReturnType<typeof order>) => ({
        ...row,
        earlierOpenPickup: false,
      });
      // Today's 3: two accepted table orders of other testers and the New order to accept.
      const todays = [
        listed(order(703, "3", liveToday, new Date(now - 60_000).toISOString(), true)),
        listed(order(702, "2", liveToday, new Date(now - 5 * 60_000).toISOString(), false)),
        listed(order(701, "1", liveToday, new Date(now - 9 * 60_000).toISOString(), false)),
      ];
      // The newest 47 of yesterday's 104, all handed over (references newest first, as served).
      const yesterdays = Array.from({ length: 47 }, (_, i) => ({
        ...listed(
          order(
            646 - i,
            String(104 - i),
            liveYesterday,
            new Date(now - (20 + i * 6) * 60_000).toISOString(),
            false,
          ),
        ),
        currentPhase: "Fulfilled",
        currentVersion: 3,
      }));
      const earlier = tm2Earlier.map((row) => ({
        ...row,
        listedBusinessDate: row.listedBusinessDate === today ? liveToday : row.listedBusinessDate,
      }));
      const answer = {
        earlierDayItems: earlier,
        items: [...todays, ...yesterdays],
        nextAfterOrderReference: id(600),
        todayOrderCount: 3,
      };
      await page.route("**/merchant/session", (route) =>
        route.fulfill({
          headers,
          json: { ...session, workspace: { ...session.workspace, businessDate: liveToday } },
        }),
      );
      await page.route("**/merchant/business-day", (route) =>
        route.fulfill({
          headers,
          json: {
            businessDate: liveToday,
            startsAt: new Date(now - 6 * 60_000).toISOString(),
            endsAt: new Date(now + 24 * 3_600_000 - 6 * 60_000).toISOString(),
            timeZone: "America/Toronto",
            observedAt: new Date(now).toISOString(),
          },
        }),
      );
      for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
        await page.route(pattern, (route) => route.fulfill({ headers, json: answer }));
      await page.goto("/operations/orders");
      const rows = page.locator("li.order-row:not([hidden])");
      // Today: today's 3 and the 46 earlier-day orders; yesterday's finished ones are not shown.
      await expect(rows).toHaveCount(49);
      const meta = page.locator(".workspace-page__meta");
      await expect(meta).toHaveText(
        en
          ? "3 orders today · 1 to accept · 46 from earlier days (1 to accept)"
          : "今天 3 单 · 1 单待接 · 另有 46 单来自较早营业日（1 单待接）",
      );
      // Each count phrase stays on one line, with room left for wider Linux fonts (DejaVu Sans).
      const phrases = en
        ? ["3 orders today", "1 to accept", "46 from earlier days (1 to accept)"]
        : ["今天 3 单", "1 单待接", "另有 46 单来自较早营业日（1 单待接）"];
      const lines = await meta.evaluate((element, wanted) => {
        const text = element.textContent ?? "";
        const nodes: Text[] = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
          nodes.push(node as Text);
        const at = (offset: number): [Text, number] => {
          let left = offset;
          for (const node of nodes) {
            if (left <= node.length) return [node, left];
            left -= node.length;
          }
          const last = nodes[nodes.length - 1] as Text;
          return [last, last.length];
        };
        const width = element.getBoundingClientRect().width;
        return wanted.map((phrase) => {
          const start = text.indexOf(phrase);
          if (start < 0) return { phrase, lines: -1, spare: -1 };
          const range = document.createRange();
          range.setStart(...at(start));
          range.setEnd(...at(start + phrase.length));
          const tops = new Set(
            Array.from(range.getClientRects())
              .filter((rect) => rect.width > 0)
              .map((rect) => Math.round(rect.top)),
          );
          return { phrase, lines: tops.size, spare: width - range.getBoundingClientRect().width };
        });
      }, phrases);
      for (const line of lines) {
        expect(line.lines, JSON.stringify(line)).toBe(1);
        expect(line.spare, JSON.stringify(line)).toBeGreaterThanOrEqual(40);
      }
      // The New order is still the first row on the first screen under the header.
      const fresh = rows.first();
      await expect(fresh.locator(".order-row__open")).toContainText("3");
      await page.evaluate(() => window.scrollTo(0, 0));
      const bottom = await fresh.evaluate(
        (row) => row.getBoundingClientRect().bottom + window.scrollY,
      );
      expect(bottom, `${language} ${width}`).toBeLessThanOrEqual(height - 40);
      const tabs = page.locator(".order-status-filters button");
      const tab = (name: string) => tabs.filter({ hasText: name });
      await expect(tab(en ? "All" : "全部").locator(".order-status-filters__count")).toHaveText(
        "49",
      );
      await page.screenshot({
        path: test.info().outputPath(`orders-footer-${language}-${width}.png`),
      });
      // To accept: today's New order and the 11/4 table order. The footer counts the 49 rows
      // Today shows (as All does), and still says the next page is not searched.
      await tab(en ? "To accept" : "待接单").click();
      await expect(rows).toHaveCount(2);
      const footer = page.locator(".order-queue-filter-count");
      await expect(footer).toHaveText(
        en
          ? "2 of 49 orders on this page match. Other pages are not searched."
          : "本页 49 笔订单中有 2 笔符合。不搜索其他页。",
      );
      // Back on All, Today that fits says nothing more under the list.
      await tab(en ? "All" : "全部").click();
      await expect(footer).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      await page.screenshot({
        path: test.info().outputPath(`orders-footer-toaccept-${language}-${width}.png`),
      });
      await expectNoInternalText(page);
    });
