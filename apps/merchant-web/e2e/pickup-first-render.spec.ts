import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { notPausedServiceControl } from "./service-control-state";

/**
 * Batch 52 (v15 batch 51 live, Test Merchant 2, other testers active): staff opening Pickup at the
 * counter saw no order and no Refresh for about 3 s. The list waited for the Store's hours read
 * (up to 2 s) although the closing step it waits for has its own line for staff shown Pause
 * ordering, and the loading screen had no Refresh. Now the page and Refresh show at once and the
 * list shows as soon as its own read answers; Refresh pressed during a slow read keeps whichever
 * answer comes first. Synthetic HTTP interception on the production build,
 * TEST-only data; no pickup code is part of the queue read.
 */
const id = (n: number) => "0190b052-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const store = id(99);
const scope = {
  brandLabel: "Test Merchant 2",
  storeLabel: "Test Merchant 2 Main - not production",
  storeReference: store,
  timeZone: "America/Toronto",
};
const observedAt = "2026-11-23T07:09:00.000Z";
const words = {
  en: {
    heading: "Pickup",
    refresh: "Refresh",
    loading: "Loading pickups…",
    order: "Order 42",
    mark: "Mark not collected",
    checked: "I checked the pickup shelf and nobody collected this order",
    close: "Close as not collected",
    closed: "Order 42 closed as not collected.",
  },
  "zh-Hans": {
    heading: "自取",
    refresh: "刷新",
    loading: "正在加载取餐…",
    order: "42 号单",
    mark: "标记未取餐",
    checked: "我已检查取餐架，没有人取走这笔订单",
    close: "作为未取餐关闭",
    closed: "42 号单已作为未取餐关闭。",
  },
} as const;
/** One paid pickup order the kitchen just finished (Beef noodles), as at Test Merchant 2. */
const queue = {
  source: "CurrentFulfillment",
  workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
  storeReference: store,
  observedAt,
  nextAfterFulfillmentReference: null,
  items: [
    {
      fulfillmentReference: id(68),
      orderReference: id(168),
      phase: "Ready",
      aggregateVersion: "4",
      readyAt: "2026-11-23T07:07:24.000Z",
      publicOrderReference: "T".repeat(22),
      proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-11-23T08:07:24.000Z" },
      items: [
        {
          fulfillmentItemReference: id(268),
          orderedQuantity: 1,
          readyQuantity: 1,
          handedOverQuantity: 0,
          name: "Beef noodles (TEST)",
          options: [],
        },
      ],
    },
  ],
};

async function counter(
  page: Page,
  options: { readonly dayMs: number; readonly queueMs: readonly number[] },
) {
  const answered = { day: [] as number[], queue: [] as number[] };
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
          businessDate: "2026-11-22",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          pauseOrderingShown: true,
          navigation: [
            {
              screenId: "FUL-PICKUP-QUEUE",
              label: "Pickup",
              href: "/operations/pickup",
              permission: "fulfillment.operate",
            },
          ],
        },
      },
    }),
  );
  // The Store's hours answer slowly, as under several testers at once.
  await page.route("**/merchant/business-day", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, options.dayMs));
    answered.day.push(Date.now());
    return route.fulfill({
      headers,
      json: {
        businessDate: "2026-11-22",
        startsAt: "2026-11-22T09:00:00.000Z",
        endsAt: "2026-11-23T09:00:00.000Z",
        timeZone: scope.timeZone,
        observedAt,
      },
    });
  });
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: notPausedServiceControl(store, scope.timeZone) }),
  );
  let reads = 0;
  await page.route("**/merchant/pickup/query", async (route) => {
    const wait = options.queueMs[Math.min(reads, options.queueMs.length - 1)] ?? 0;
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, wait));
    answered.queue.push(Date.now());
    return route.fulfill({ headers, json: queue }).catch(() => undefined);
  });
  return { answered, reads: () => reads };
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`@production Pickup shows its list as soon as it is read, before a slow hours read, ${language} at ${width}`, async ({
      page,
    }) => {
      const text = words[language];
      if (language === "zh-Hans")
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      const { answered } = await counter(page, { dayMs: 4_000, queueMs: [300] });
      await page.goto("/operations/pickup");
      const main = page.getByRole("main");
      await expect(page.getByRole("heading", { name: text.heading, level: 1 })).toBeVisible();
      // The list shows as soon as its own read answers, not after the Store's hours.
      await expect(main.locator("article")).toHaveCount(1, { timeout: 3_000 });
      const shownAt = Date.now();
      expect(answered.queue.length).toBe(1);
      expect(answered.day).toEqual([]);
      expect(shownAt - (answered.queue[0] ?? 0)).toBeLessThan(1_000);
      const refresh = main.getByRole("button", { name: text.refresh, exact: true });
      await expect(refresh).toBeEnabled();
      const box = await refresh.boundingBox();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);
      await noOverflow(page);
      await page.screenshot({ path: `test-results/b52/pickup-list-${language}-${width}.png` });
      await expectNoInternalText(page);
    });

    test(`@production Refresh on the loading Pickup page asks again and shows the list, ${language} at ${width}`, async ({
      page,
    }) => {
      const text = words[language];
      if (language === "zh-Hans")
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      // The first read hangs (a busy server); the one Refresh sends answers at once.
      const { reads } = await counter(page, { dayMs: 100, queueMs: [60_000, 0] });
      await page.goto("/operations/pickup");
      const main = page.getByRole("main");
      await expect(main.getByText(text.loading)).toBeVisible();
      await expect.poll(reads).toBe(1);
      // While it is loading, the page and Refresh are already there.
      await expect(page.getByRole("heading", { name: text.heading, level: 1 })).toBeVisible();
      const refresh = main.getByRole("button", { name: text.refresh, exact: true });
      await expect(refresh).toBeEnabled({ timeout: 1_000 });
      const box = await refresh.boundingBox();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);
      await noOverflow(page);
      await page.screenshot({ path: `test-results/b52/pickup-loading-${language}-${width}.png` });
      await refresh.click({ timeout: 2_000 });
      await expect(main.locator("article")).toHaveCount(1, { timeout: 3_000 });
      expect(reads()).toBe(2);
      await expect(main.getByRole("button", { name: text.refresh, exact: true })).toBeFocused();
      await noOverflow(page);
    });

    test(`@production Refresh pressed during a slow Pickup read keeps the answer that comes first, ${language} at ${width}`, async ({
      page,
    }) => {
      const text = words[language];
      if (language === "zh-Hans")
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      // The first read is slow but answers after 2 s; staff press Refresh at 1 s, and the read
      // Refresh sends is slower still. The first answer is not thrown away.
      const { answered, reads } = await counter(page, { dayMs: 100, queueMs: [2_000, 60_000] });
      await page.goto("/operations/pickup");
      const main = page.getByRole("main");
      await expect.poll(reads).toBe(1);
      const firstAskedAt = Date.now();
      const refresh = main.getByRole("button", { name: text.refresh, exact: true });
      await expect(refresh).toBeEnabled({ timeout: 1_000 });
      await page.waitForTimeout(Math.max(0, 1_000 - (Date.now() - firstAskedAt)));
      expect(answered.queue).toEqual([]);
      await refresh.click({ timeout: 1_000 });
      await expect.poll(reads).toBe(2);
      await expect(main.locator("article")).toHaveCount(1, { timeout: 3_000 });
      expect(answered.queue.length).toBe(1);
      expect(Date.now() - (answered.queue[0] ?? 0)).toBeLessThan(1_000);
      await expect(main.getByRole("button", { name: text.refresh, exact: true })).toBeFocused();
      await noOverflow(page);
      await expectNoInternalText(page);
    });
  }

/**
 * Batch 52 fix-up (review of 929d03902): a queue read that was already out when staff closed an
 * order as not collected must not be taken as the list after that close. Before, its answer was
 * shown as the latest check, after the close, with the order still waiting beside the "closed"
 * confirmation. Now every read started before a write on this screen is dropped; the read the
 * close sends shows the order gone. Synthetic HTTP interception, TEST-only data.
 */
async function closingCounter(page: Page, queueMs: readonly number[]) {
  const answered: { at: number; waiting: boolean }[] = [];
  const now = Date.now();
  let closed = false;
  let closedAt = 0;
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
          businessDate: "2026-11-22",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          pauseOrderingShown: true,
          navigation: [
            {
              screenId: "FUL-PICKUP-QUEUE",
              label: "Pickup",
              href: "/operations/pickup",
              permission: "fulfillment.operate",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-11-22",
        startsAt: new Date(now - 4 * 3_600_000).toISOString(),
        endsAt: new Date(now + 10 * 3_600_000).toISOString(),
        timeZone: scope.timeZone,
        observedAt: new Date(now).toISOString(),
      },
    }),
  );
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: notPausedServiceControl(store, scope.timeZone) }),
  );
  let reads = 0;
  await page.route("**/merchant/pickup/query", async (route) => {
    const wait = queueMs[Math.min(reads, queueMs.length - 1)] ?? 0;
    reads += 1;
    // The server reads the queue when the request arrives; the answer may come much later.
    const waiting = !closed;
    const at = Date.now();
    const json = {
      source: "CurrentFulfillment",
      workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
      storeReference: store,
      observedAt: new Date(at).toISOString(),
      nextAfterFulfillmentReference: null,
      items: waiting
        ? [
            {
              fulfillmentReference: id(1),
              orderReference: id(3),
              phase: "Ready",
              aggregateVersion: "7",
              readyAt: new Date(now - 70 * 60_000).toISOString(),
              publicOrderReference: "D".repeat(22),
              orderNumber: "42",
              proof: {
                kind: "HumanCode",
                generation: 1,
                expiresAt: new Date(now - 10 * 60_000).toISOString(),
              },
              items: [
                {
                  fulfillmentItemReference: id(4),
                  orderedQuantity: 1,
                  readyQuantity: 1,
                  handedOverQuantity: 0,
                  name: "Beef noodles (TEST)",
                  options: [],
                },
              ],
            },
          ]
        : [],
    };
    await new Promise((resolve) => setTimeout(resolve, wait));
    answered.push({ at: Date.now(), waiting });
    return route.fulfill({ headers, json }).catch(() => undefined);
  });
  await page.route("**/merchant/pickup/not-collected", async (route) => {
    closed = true;
    closedAt = Date.now();
    await route.fulfill({
      headers,
      json: { status: "Applied", fulfillmentReference: id(1), closedAt: new Date().toISOString() },
    });
  });
  return { answered, reads: () => reads, closedAt: () => closedAt };
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const)
    test(`@production A Pickup read already out when an order is closed as not collected does not bring it back, ${language} at ${width}`, async ({
      page,
    }) => {
      const text = words[language];
      if (language === "zh-Hans")
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      // Read 1 answers at once; the Refresh read is slow (2.5 s) and answers after the close; the
      // read the close sends is slower still (5 s).
      const { answered, reads, closedAt } = await closingCounter(page, [0, 2_500, 5_000]);
      await page.goto("/operations/pickup");
      const main = page.getByRole("main");
      const card = main.getByRole("heading", { name: text.order });
      await expect(card).toBeVisible();
      // The page's one stamp: in its header, or in the top bar at 1024 (batch 63, F38).
      const checked = page.locator(".workspace-page__freshness time");
      const firstChecked = await checked.getAttribute("datetime");
      await main.getByRole("button", { name: text.refresh, exact: true }).click();
      await expect.poll(reads).toBe(2);
      await main.getByRole("button", { name: text.mark, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(text.checked).check();
      await dialog.getByRole("button", { name: text.close, exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: text.closed })).toBeVisible();
      await expect.poll(reads).toBe(3);
      await page.keyboard.press("Escape");
      // The Refresh read, asked before the close, answers now with the order still waiting.
      await expect.poll(() => answered.length, { timeout: 5_000 }).toBe(2);
      expect(answered[1]?.waiting).toBe(true);
      expect(answered[1]?.at ?? 0).toBeGreaterThan(closedAt());
      await page.waitForTimeout(300);
      // It is not taken as the list after the close: the screen does not say it checked the queue
      // after the close while showing the order as waiting.
      expect(await checked.getAttribute("datetime")).toBe(firstChecked);
      // The read the close sent shows the order gone, and nothing brings it back.
      await expect(card).toHaveCount(0, { timeout: 6_000 });
      await expect(page.getByRole("status").filter({ hasText: text.closed })).toBeVisible();
      await page.waitForTimeout(500);
      await expect(card).toHaveCount(0);
      expect(Date.parse((await checked.getAttribute("datetime")) ?? "")).toBeGreaterThan(
        closedAt(),
      );
      await noOverflow(page);
      await page.screenshot({ path: `test-results/b52/pickup-closed-${language}-${width}.png` });
      await expectNoInternalText(page);
    });
