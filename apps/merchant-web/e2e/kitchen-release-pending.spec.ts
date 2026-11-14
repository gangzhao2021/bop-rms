import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { openOrder, orderPanel } from "./order-queue-helpers";

/**
 * WP-2423 M04: staff accepted a paid order, and the kitchen gets it only when the payment worker
 * releases it (within seconds). Orders said "Sent to the kitchen" at once, and when the release
 * failed nothing said so for 8 to 19 minutes. Orders now says it is being sent, then (a minute after
 * acceptance) that it has not reached the kitchen; a pickup whose automatic refund did not go
 * through asks staff to reject it; Home counts both. Synthetic HTTP interception on the production
 * build, not live Store evidence (the server read runs in dining-move-paid-round).
 */
const id = (n: number) => "01a0f0e4-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const start = Date.parse("2026-11-06T20:00:00.000Z");
const ago = (seconds: number) => new Date(start - seconds * 1000).toISOString();
const navigation = [
  { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
  {
    screenId: "OPS-ORDER-QUEUE",
    label: "Orders",
    href: "/operations/orders",
    permission: "ordering.operate",
  },
];
const order = (n: number, batch: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  orderReference: id(n),
  orderNumber: String(n),
  orderType: "Pickup",
  sourceChannel: "Web",
  submittedAt: ago(600),
  observedAt: ago(0),
  initialBatchReference: id(n + 50),
  batches: [
    {
      orderBatchReference: id(n + 50),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
      kitchenRelease: null,
      automaticRefundLate: false,
      ...batch,
    },
  ],
  canRequestAcceptance: false,
  currentPhase: "Accepted",
  currentVersion: 2,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  acceptanceHold: null,
  awaitingPayment: false,
  ...extra,
});
const queue = {
  // Newest first.
  items: [
    order(33, { kitchenRelease: { state: "Sending", acceptedAt: ago(10) } }),
    order(
      32,
      {
        acceptanceStatus: "NotAccepted",
        canRequestAcceptance: true,
        canCancel: true,
        automaticRefundLate: true,
      },
      {
        canRequestAcceptance: true,
        currentPhase: "Submitted",
        currentVersion: 1,
        acceptBy: ago(180),
      },
    ),
    order(31, { kitchenRelease: { state: "NotInKitchen", acceptedAt: ago(190) } }),
  ],
  nextAfterOrderReference: null,
};

async function signIn(page: Page, language: "en" | "zh-Hans") {
  await page.addInitScript((chosen) => {
    window.localStorage.setItem("bop.merchant.language", chosen);
  }, language);
  await page.clock.install({ time: new Date(start) });
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
          businessDate: "2026-11-06",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation,
        },
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-11-06",
        startsAt: "2026-11-06T09:00:00.000Z",
        endsAt: "2026-11-07T09:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: ago(0),
      },
    }),
  );
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, status: 403, json: { error: "denied" } }),
  );
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: queue }));
}

test("@production Orders says a paid order is being sent, not in the kitchen, or not refunded", async ({
  page,
}) => {
  await signIn(page, "en");
  await page.goto("/operations/orders");
  await openOrder(page, "33");
  const sending = orderPanel(page)
    .getByRole("status")
    .filter({ hasText: "Sending to the kitchen…" });
  await expect(sending).toBeVisible();
  await expect(orderPanel(page)).not.toContainText("Sent to the kitchen");
  await openOrder(page, "31");
  const late = orderPanel(page).getByRole("status").filter({ hasText: "Not in the kitchen yet" });
  await expect(late).toContainText(
    "Paid and accepted 3 min ago, but the kitchen hasn't received it. Make it from the dishes listed here and tell the manager.",
  );
  await openOrder(page, "32");
  await expect(
    orderPanel(page)
      .getByRole("status")
      .filter({ hasText: "The automatic refund didn't go through." }),
  ).toContainText("Press Refuse and refund to give the guest their money back in full.");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/kitchen-release-pending-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);
});

test("@production Home and Orders say it in Chinese, with no codes", async ({ page }) => {
  await signIn(page, "zh-Hans");
  await page.goto("/app");
  await expect(page.getByText("需要你处理的已付订单")).toBeVisible();
  await expect(
    page.getByText(
      "2 笔订单已付款，但没进后厨或没有按规定退款。请在“订单”里逐一打开查看怎么处理。",
    ),
  ).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/kitchen-release-pending-home-zh-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);
  await page.goto("/operations/orders");
  await openOrder(page, "31");
  await expect(
    orderPanel(page).getByRole("status").filter({ hasText: "还没进后厨" }),
  ).toContainText("已付款，3 分钟前已接单，但后厨还没收到。请按这里列出的菜品制作，并告诉经理。");
  await openOrder(page, "33");
  await expect(orderPanel(page).getByText("正在发送到后厨…")).toBeVisible();
  await expectNoInternalText(page);
});
