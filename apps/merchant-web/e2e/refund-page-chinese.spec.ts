import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// A manager whose staff language is Chinese refunds from a table's order: eight portions of the
// same dish, each its own line, plus a card-machine refund an owner already approved.
const id = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const dishes = [
  ...Array.from({ length: 8 }, (_, index) => ({ index, label: "麻婆豆腐 · 微辣", quantity: 1 })),
  { index: 8, label: "鲜肉小笼包", quantity: 3 },
];
const approvedRequest = {
  requestReference: id(41),
  operationReference: id(51),
  claimVersion: 1,
  requestedAt: "2026-10-15T15:00:00.000Z",
  reasonCode: "QUALITY_ISSUE",
  currencyCode: "CAD",
  amountMinor: "12430",
  decline: null,
  progress: "Recorded",
  paymentMethod: "CardMachine",
};

async function stubPayment(page: Page, statusReads: string[]) {
  await page.addInitScript(() => localStorage.setItem("bop.merchant.language", "zh-Hans"));
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
          businessDate: "2026-10-15",
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
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({
      headers,
      json: {
        paymentIntentReference: id(31),
        paymentAttemptReference: id(32),
        orderReference: id(1),
        orderBatchReference: id(90),
        observedAt: new Date().toISOString(),
        paymentState: "Captured",
        paymentMethod: "CardMachine",
        currencyCode: "CAD",
        capturedAmountMinor: "48000",
        confirmedRefundMinor: "0",
        pendingRefundMinor: "12430",
        canRequest: true,
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: false,
        soleOperator: null,
        entries: [
          {
            orderReference: id(1),
            orderNumber: "T4-2",
            requestReference: id(41),
            paymentIntentReferences: [id(31)],
            paymentMethod: "CardMachine",
            currencyCode: "CAD",
            amountMinor: "12430",
            reasonCode: "QUALITY_ISSUE",
            note: null,
            escalationReasons: ["OrderOrdinaryTotalAboveCad100"],
            requestedAt: "2026-10-15T15:00:00.000Z",
            requesterName: "Mia",
            requestedByYou: true,
            requesterVerifiedUntil: null,
            state: "Approved",
            approvalReference: id(61),
            approvedAt: "2026-10-15T15:01:00.000Z",
            approverName: "Owner",
            canApprove: false,
            soleOperatorApproval: false,
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        orderNumber: "T4-2",
        canRequest: true,
        claimVersion: 1,
        recentRequests: [approvedRequest],
        items: dishes.map(({ index, label, quantity }) => ({
          orderBatchReference: id(90),
          orderItemReference: id(100 + index),
          label,
          quantity,
          unclaimedQuantity: quantity,
          paymentCaptured: true,
          refundedByCancellation: false,
          paymentIntentReference: id(31),
          paymentMethod: "CardMachine",
        })),
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/status", (route) => {
    statusReads.push(route.request().postData() ?? "");
    return route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        requestReference: id(41),
        operationReference: id(51),
        observedAt: new Date().toISOString(),
        currencyCode: "CAD",
        amountMinor: "12430",
        payments: [
          {
            paymentAttemptReference: id(32),
            paymentIntentReference: id(31),
            state: "NotDispatched",
            method: "CardMachine",
            refundedOnCardMachineAt: null,
            cardMachineSlipReference: null,
            executionOperationReference: null,
            executionApprovalReference: null,
            amountMinor: "12430",
            confirmedMinor: "0",
            pendingMinor: "12430",
          },
        ],
      },
    });
  });
  await page.route("**/merchant/payments/refunds/preview", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    return route.fulfill({
      headers,
      json: {
        status: "Previewed",
        requestReference: body.requestReference,
        operationReference: body.operationReference,
        claimVersion: 1,
        currencyCode: "CAD",
        amountMinor: "35570",
        paymentAttemptReferences: [id(32)],
        approvalRequired: false,
        escalationReasons: [],
        approveAlone: false,
        components: {
          netAmountMinor: "31478",
          taxAmountMinor: "4092",
          tipAmountMinor: "0",
          serviceChargeAmountMinor: "0",
          serviceChargeTaxAmountMinor: "0",
        },
      },
    });
  });
}

async function fitsAndLooksRight(page: Page, name: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${name} overflows at ${width}`,
    ).toBe(true);
    // REFUND_SCREENSHOTS keeps them for a design review (a passing run deletes its output folder).
    const folder = process.env.REFUND_SCREENSHOTS;
    await page.screenshot({
      path: folder
        ? `${folder}/${name}-${width}.png`
        : test.info().outputPath(`${name}-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("@production the refund page opens ready in Chinese: items loaded, record control shown, one tap fills all", async ({
  page,
}) => {
  const statusReads: string[] = [];
  await stubPayment(page, statusReads);
  await page.goto("/app/operations/payments/" + id(31) + "/refund");

  // Nothing to press first: the items and the approved refund's record control are on screen.
  await expect(page.getByRole("heading", { level: 1, name: "退款" })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回订单" })).toHaveAttribute(
    "href",
    "/operations/orders/" + id(1),
  );
  const steppers = page.getByRole("spinbutton");
  await expect(steppers).toHaveCount(9);
  const requests = page.getByRole("region", { name: "这笔订单的退款" });
  await expect(requests).toContainText("已批准 — 请在刷卡机上退款并记录");
  await expect(requests.getByRole("button", { name: "已在刷卡机上退款 $124.30" })).toBeVisible();
  await expect(requests.getByRole("textbox", { name: "签购单参考号（可选）" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  // Once each, with no loop of rereads after the page settles.
  expect(statusReads).toHaveLength(1);
  await fitsAndLooksRight(page, "refund-open");

  // One tap fills every identical line and the rest; the stepper still adjusts one line.
  await page.getByRole("button", { name: "全部退款" }).click();
  for (const [index, { quantity }] of dishes.entries())
    await expect(steppers.nth(index)).toHaveValue(String(quantity));
  await page.getByRole("button", { name: "鲜肉小笼包 减一份" }).click();
  await expect(page.getByRole("spinbutton", { name: /鲜肉小笼包/u })).toHaveValue("2");
  await page.getByRole("button", { name: "鲜肉小笼包 加一份" }).click();
  await expect(page.getByRole("button", { name: "鲜肉小笼包 加一份" })).toBeDisabled();

  await page.getByRole("combobox", { name: "原因" }).selectOption("QUALITY_ISSUE");
  await page.getByRole("button", { name: "核对退款", exact: true }).click();
  const review = page.getByRole("region", { name: "核对这笔退款" });
  await expect(review).toContainText("$355.70");
  // The money guard stays: nothing can be recorded until it is ticked.
  const record = review.getByRole("button", { name: "记录退款申请" });
  await expect(record).toBeDisabled();
  await review.getByRole("checkbox").check();
  await expect(record).toBeEnabled();
  await fitsAndLooksRight(page, "refund-review");

  await expect(
    page.getByText(/Refund|Request|Review|Reason|Paid|Loading|Refresh|card machine/u),
  ).toHaveCount(0);
  await expectNoInternalText(page);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual(
    [],
  );
});

test("@production the payment page reads calmly in Chinese and goes straight into the refund", async ({
  page,
}) => {
  await stubPayment(page, []);
  await page.goto("/app/operations/payments/" + id(31));
  const summary = page.getByRole("region", { name: "付款概况" });
  await expect(summary).toContainText("已付款，退款处理中");
  await expect(summary).toContainText("$480.00");
  await expect(summary).toContainText("$124.30");
  const toRecord = page.getByRole("region", { name: "需要在刷卡机上办理的退款" });
  await expect(toRecord.getByRole("button", { name: "记录 $124.30 刷卡机退款" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await fitsAndLooksRight(page, "payment");
  await expectNoInternalText(page);
  await page.getByRole("link", { name: "发起退款" }).click();
  await expect(page.getByRole("spinbutton")).toHaveCount(9);
});
