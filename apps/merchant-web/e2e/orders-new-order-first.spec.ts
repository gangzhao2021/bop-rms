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
          name: language === "en" ? "Earlier days · not finished" : "之前营业日 · 还没做完",
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
