import { expect, test } from "@playwright/test";
import { chooseOrderFilter, openOrder, orderPanel } from "./order-queue-helpers";

/**
 * WP-2423 Q21: "today" on the merchant screens is the Store's business day (its time zone and
 * business-day start, here 04:00 in Toronto), the same day settlement closes — not the calendar day.
 * At 01:30 on Oct 15 the late service still belongs to the Oct 14 business day.
 */
const id = (n: number) => "018f7721-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandLabel: "Synthetic Brand", storeLabel: "Night Store", storeReference: id(99) };
const headers = { "cache-control": "no-store" };
const nowAt = "2026-10-15T05:30:00.000Z"; // 01:30 in Toronto

test.use({ timezoneId: "America/Toronto" });

async function workspace(page: import("@playwright/test").Page) {
  await page.clock.setFixedTime(new Date(nowAt));
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-10-14",
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
            {
              screenId: "PAY-RECONCILIATION",
              label: "Settlement",
              href: "/app/operations/payment-reconciliation",
              permission: "payment.settlement.read",
            },
          ],
        },
      },
    }),
  );
  const reads: string[] = [];
  await page.route("**/merchant/business-day", (route) => {
    reads.push(route.request().method());
    return route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-14",
        startsAt: "2026-10-14T08:00:00.000Z",
        endsAt: "2026-10-15T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: nowAt,
      },
    });
  });
  return reads;
}

const order = (n: number, businessDate: string, submittedAt: string) => ({
  orderReference: id(n),
  orderNumber: "A-" + n,
  orderType: "Pickup",
  sourceChannel: "Web",
  businessDate,
  submittedAt,
  observedAt: nowAt,
  initialBatchReference: id(100 + n),
  batches: [
    {
      orderBatchReference: id(100 + n),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: false,
  currentPhase: "Accepted",
  currentVersion: 2,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
});

test("@production Orders after midnight stay under the Store's business day", async ({ page }) => {
  const reads = await workspace(page);
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          // 00:40 and 23:50 local: one business day across midnight; A-3 is the day before.
          order(5, "2026-10-14", "2026-10-15T04:40:00.000Z"),
          order(4, "2026-10-14", "2026-10-15T03:50:00.000Z"),
          order(3, "2026-10-13", "2026-10-14T01:15:00.000Z"),
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.goto("/operations/orders");
  const days = page.locator(".order-workbench-day");
  // Owner 2026-10-25: Orders opens on today; every loaded day is one choice away.
  await expect(days).toHaveText(["Today · Wed, Oct 14"]);
  await chooseOrderFilter(page, "Date", "All days");
  await expect(days).toHaveText(["Today · Wed, Oct 14", "Yesterday · Tue, Oct 13"]);
  expect(reads.length).toBeGreaterThan(0);
  const afterMidnight = page.locator("li.order-row").first();
  await expect(afterMidnight).toContainText("A-5");
  await expect(afterMidnight.locator(".order-workbench-time")).toHaveText("00:40");
  await openOrder(page, "A-5");
  // Orders v3: one date style (the calendar day it was placed, then the time).
  await expect(
    orderPanel(page)
      .getByText(/Oct 15 00:40/u)
      .first(),
  ).toBeVisible();
  await expect(orderPanel(page).getByText("Today · Wed, Oct 14", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await expect(days.first()).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/q21-orders-business-day-${width}.png` });
  }
});

test("@production Settlement offers the Store's business day as the latest day", async ({
  page,
}) => {
  await workspace(page);
  await page.route("**/merchant/settlement*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "PAY-RECONCILIATION",
        storeLabel: scope.storeLabel,
        businessDate: "2026-10-13",
        window: {
          startsAt: "2026-10-13T08:00:00.000Z",
          endsAt: "2026-10-14T08:00:00.000Z",
          timeZone: "America/Toronto",
          status: "Closed",
        },
        captured: { count: 0, amountMinor: "0", currencyCode: "CAD" },
        refunded: { count: 0, amountMinor: "0", currencyCode: "CAD" },
        selfApprovedRefunds: { count: 0, amountMinor: "0", currencyCode: "CAD" },
        reconciliation: {
          settlement: null,
          operational: {
            runCount: 0,
            latestRun: null,
            paymentCount: 0,
            outcomes: { Matched: 0, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 0 },
          },
          differences: [],
          differenceCount: 0,
        },
        projectedAt: nowAt,
      },
    }),
  );
  await page.goto("/app/operations/payment-reconciliation");
  await expect(page.getByRole("heading", { name: "Business day: Tue, Oct 13" })).toBeVisible();
  // The device's calendar says Oct 15; the Store's business day (and settlement) says Oct 14.
  await expect(page.getByRole("textbox", { name: "Business day" })).toHaveAttribute(
    "max",
    "2026-10-14",
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/q21-settlement-business-day-${width}.png` });
  }
});
