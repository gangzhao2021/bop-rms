import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { openOrder, orderPanel, orderRows } from "./order-queue-helpers";

/**
 * v15 b12 (orders-and-wording): a paper order paid during the outage and entered again as another
 * order reads paid on paper with the order that carries its sale in its row's money column and its
 * Record, and is not one of the Cancelled; a pickup contact the guest removed says the guest asked.
 * In English and Chinese, at 1440, 1024 and 390. Synthetic, TEST-only data.
 */
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const businessDate = "2026-11-13";
const paperOrder = {
  orderReference: id(73),
  orderNumber: "73",
  orderType: "Pickup",
  sourceChannel: "Pos",
  submittedAt: "2026-11-13T05:40:00.000Z",
  observedAt: "2026-11-13T06:13:00.000Z",
  initialBatchReference: id(173),
  batches: [
    {
      orderBatchReference: id(173),
      sequence: 1,
      acceptanceStatus: "NotAccepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: false,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
  currentPhase: "Cancelled",
  currentVersion: 2,
  counter: {
    recordedAfterOutage: true,
    paidOnCardMachine: null,
    payBy: "2026-11-13T06:00:00.000Z",
    amountDueMinor: null,
    canCancelUnpaid: false,
    canCloseAsReentered: false,
    cancelledBeforePayment: {
      reasonCode: "COUNTER_PAPER_REENTERED",
      cancelledAt: "2026-11-13T06:12:00.000Z",
      reenteredOrderNumber: "85",
    },
  },
  canRecordCardMachinePayment: false,
  canViewPayments: false,
};
const pickupOrder = {
  orderReference: id(40),
  orderNumber: "40",
  orderType: "Pickup",
  sourceChannel: "Qr",
  submittedAt: "2026-11-13T05:30:00.000Z",
  observedAt: "2026-11-13T05:31:00.000Z",
  initialBatchReference: id(140),
  batches: [
    {
      orderBatchReference: id(140),
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
  currentVersion: 3,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
  paidOnline: money("367"),
};
const lines = (batch: string, total: string) => ({
  items: [
    {
      orderItemReference: id(201),
      orderBatchReference: batch,
      name: "Soy milk (TEST)",
      options: [],
      quantity: 1,
      customerNote: null,
      unitPrice: money("325"),
      subtotal: money("325"),
      discount: money("0"),
      tax: money("42"),
      fee: money("0"),
      total: money(total),
      canCancel: false,
      cancellation: null,
    },
  ],
  totals: {
    subtotal: money("325"),
    discount: money("0"),
    tax: money("42"),
    fee: money("0"),
    total: money(total),
  },
});
const emptyRecord = {
  accepted: [],
  handedOver: [],
  payments: [],
  cancellations: [],
  refunds: [],
  writeOff: null,
  paidOnlineByGuest: false,
};

async function routes(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await page.addInitScript(() => window.localStorage.setItem("bop.merchant.language", "zh-Hans"));
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
          businessDate,
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
      },
    }),
  );
  const listed = { items: [paperOrder, pickupOrder], nextAfterOrderReference: null };
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: listed }));
  await page.route("**/merchant/orders?*", (route) => route.fulfill({ headers, json: listed }));
  await page.route("**/merchant/orders/detail?*", (route) => {
    const order = new URL(route.request().url()).searchParams.get("order");
    const paper = order === paperOrder.orderReference;
    return route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        order: { ...(paper ? paperOrder : pickupOrder), kitchenPhase: null },
        paymentPosition: paper ? null : { refundedMinor: "0", refundPendingMinor: "0" },
        lines: lines(paper ? id(173) : id(140), "367"),
        pickupContact: paper
          ? { status: "NotGiven" }
          : { status: "Removed", removedAt: "2026-11-13T05:50:00.000Z", because: "GuestAsked" },
        record: paper
          ? {
              ...emptyRecord,
              cancellations: [{ what: "Order", by: "You", at: "2026-11-13T06:12:00.000Z" }],
            }
          : emptyRecord,
      },
    });
  });
}

/** Filter → one Order status choice (the helper's, with the button's name in either language). */
async function chooseOrderFilter(page: Page, group: string, option: string) {
  await page.getByRole("button", { name: /^(Filter|筛选)/u }).click();
  await page
    .getByRole("group", { name: group, exact: true })
    .getByRole("button", { name: option, exact: true })
    .click();
  await page.keyboard.press("Escape");
}

const noSideScroll = async (page: Page, name: string) => {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no side scroll at ${width}`,
    ).toBe(true);
    await page.screenshot({ path: `test-results/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};

for (const language of ["en", "zh-Hans"] as const)
  test(`@production b12: a paper order entered again reads paid on paper in its row and Record, outside Cancelled (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    await routes(page, language);
    await page.goto("/operations/orders");
    const row = orderRows(page).filter({ hasText: zh ? "纸单已付款" : "Paid on paper" });
    await expect(row.locator(".order-workbench-amount")).toHaveText(
      zh ? "—纸单已付款 · 这笔销售记在订单 85 上" : "—Paid on paper · its sale is on order 85",
    );
    await expect(row).not.toContainText(zh ? "未记录付款" : "No payment recorded");
    await openOrder(page, "73");
    const record = orderPanel(page).getByRole("region", { name: zh ? "记录" : "Record" });
    await expect(record).toContainText(
      zh ? "已关闭 · 已重新录入为订单 85" : "Closed · entered again as order 85",
    );
    await expect(record).not.toContainText(zh ? "已取消" : "Cancelled");
    await noSideScroll(page, `b12-paper-reentered-${language}`);
    await expectNoInternalText(page);
    // Under Order status: never one of the Cancelled; its own choice finds it.
    await page.goto("/operations/orders");
    await chooseOrderFilter(page, zh ? "订单状态" : "Order status", zh ? "已取消" : "Cancelled");
    await expect(page.getByRole("button", { name: "73", exact: true })).toBeHidden();
    await chooseOrderFilter(
      page,
      zh ? "订单状态" : "Order status",
      zh ? "纸单已付款 · 已重新录入" : "Paid on paper · entered again",
    );
    await expect(page.getByRole("button", { name: "73", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "40", exact: true })).toBeHidden();
  });

for (const language of ["en", "zh-Hans"] as const)
  test(`@production b12: a pickup contact the guest removed says the guest asked, never kept for a limited time (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    await routes(page, language);
    await page.goto("/operations/orders");
    await openOrder(page, "40");
    const contact = orderPanel(page).getByRole("region", {
      name: zh ? "自取顾客" : "Pickup customer",
    });
    await expect(contact).toContainText(
      zh
        ? "顾客已于 2026年11月13日 在自己的订单页删除了联系方式。"
        : "The customer removed their contact on Nov 13, 2026, from their order page.",
    );
    await expect(contact).not.toContainText(zh ? "只保留有限时间" : "limited time");
    await noSideScroll(page, `b12-contact-removed-${language}`);
    await expectNoInternalText(page);
  });
