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
  en: { heading: "Pickup", refresh: "Refresh", loading: "Loading pickups…" },
  "zh-Hans": { heading: "自取", refresh: "刷新", loading: "正在加载取餐…" },
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
