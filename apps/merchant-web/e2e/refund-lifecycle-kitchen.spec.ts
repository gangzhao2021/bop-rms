import process from "node:process";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 M10/M14/M163 (DEC-OWNER-DEFAULTS-2026-11-06 items 2, 4, 5). A manager refunding a dish
 * the kitchen has not started is asked "Stop making it too" (ticked), one already being made is
 * left for the guest (unticked); a cashier's request waits on Approvals and Home for someone to
 * send it; a refund made by mistake is corrected with Take money back. At 1440, 1024 and 390.
 */
const id = (n: number) => "01909975-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
// Screenshots for a design check, only when a directory is given (never committed).
const shots = process.env.BOP_SCREENSHOT_DIR ?? null;
async function signIn(page: Page) {
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
          businessDate: "2026-11-10",
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
              screenId: "APPROVAL-INBOX",
              label: "Approvals",
              href: "/app/approvals",
              permission: "workflow.operate",
            },
          ],
        },
      },
    }),
  );
}
const context = (patch: Record<string, unknown> = {}) => ({
  paymentIntentReference: id(31),
  paymentAttemptReference: id(32),
  orderReference: id(1),
  orderBatchReference: id(90),
  observedAt: "2026-11-10T12:00:00.000Z",
  paymentState: "Captured",
  paymentMethod: "Online",
  currencyCode: "CAD",
  capturedAmountMinor: "3000",
  confirmedRefundMinor: "0",
  pendingRefundMinor: "0",
  canRequest: true,
  requestBlocked: null,
  canSend: true,
  canRecover: false,
  recoveries: [],
  ...patch,
});
async function noApprovals(page: Page) {
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: false,
        soleOperator: null,
        entries: [],
      },
    }),
  );
}
async function noHorizontalScroll(page: Page, name: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    if (shots !== null)
      await page.screenshot({ path: shots + "/" + name + "-" + width + ".png", fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("@production M10: refunding a dish not started stops the kitchen too; one being made stays with the guest", async ({
  page,
}) => {
  await signIn(page);
  await noApprovals(page);
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({ headers, json: context() }),
  );
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        orderNumber: "21",
        canRequest: true,
        canWithdraw: true,
        claimVersion: 0,
        recentRequests: [],
        items: [
          {
            orderBatchReference: id(90),
            orderItemReference: id(3),
            label: "Fries",
            quantity: 2,
            unclaimedQuantity: 2,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: id(31),
            paymentMethod: "Online",
            kitchen: "NotStarted",
            withdrawnQuantity: 0,
          },
          {
            orderBatchReference: id(90),
            orderItemReference: id(4),
            label: "Noodles",
            quantity: 1,
            unclaimedQuantity: 1,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: id(31),
            paymentMethod: "Online",
            kitchen: "Started",
            withdrawnQuantity: 0,
          },
        ],
      },
    }),
  );
  const previews: Record<string, unknown>[] = [];
  await page.route("**/merchant/payments/refunds/preview", (route) => {
    const command = JSON.parse(route.request().postData() ?? "{}");
    previews.push(command);
    return route.fulfill({
      headers,
      json: {
        status: "Previewed",
        requestReference: command.requestReference,
        operationReference: command.operationReference,
        claimVersion: 0,
        currencyCode: "CAD",
        amountMinor: "1500",
        paymentAttemptReferences: [id(32)],
        approvalRequired: false,
        escalationReasons: [],
        components: {
          netAmountMinor: "1328",
          taxAmountMinor: "172",
          tipAmountMinor: "0",
          serviceChargeAmountMinor: "0",
          serviceChargeTaxAmountMinor: "0",
        },
      },
    });
  });
  await page.goto("/app/operations/payments/" + id(31) + "/refund");
  await page.getByRole("spinbutton", { name: /Fries/ }).fill("1");
  await page.getByRole("spinbutton", { name: /Noodles/ }).fill("1");
  const stops = page.getByRole("checkbox", { name: /Stop making it too/ });
  await expect(stops).toHaveCount(2);
  // Not started: ticked. Already being made: not ticked, the guest keeps the food.
  await expect(stops.nth(0)).toBeChecked();
  await expect(stops.nth(1)).not.toBeChecked();
  await expect(page.getByText("The kitchen and the counter leave it out.")).toBeVisible();
  await expect(page.getByText("Already being made: the guest keeps the food.")).toBeVisible();
  await page.getByRole("combobox", { name: "Reason" }).selectOption("WRONG_ITEM");
  await page.getByRole("button", { name: "Review refund" }).click();
  await expect(page.getByRole("region", { name: "Review this refund" })).toContainText("$15.00");
  expect(previews.at(-1)?.withdraw).toEqual([{ orderItemReference: id(3), quantity: 1 }]);
  await expectNoInternalText(page);
  await noHorizontalScroll(page, "refund-stop-making");
});

test("@production M14: a cashier's refund request waits for a manager to send it, on Approvals and Home", async ({
  page,
}) => {
  await signIn(page);
  const asked = {
    orderReference: id(1),
    orderNumber: "21",
    requestReference: id(101),
    requestOperationReference: id(102),
    paymentAttemptReferences: [id(32)],
    paymentIntentReferences: [id(31)],
    paymentMethod: "Online",
    currencyCode: "CAD",
    amountMinor: "750",
    reasonCode: "WRONG_ITEM",
    note: null,
    escalationReasons: [],
    requestedAt: new Date(Date.now() - 120_000).toISOString(),
    requesterName: "Mia",
    requestedByYou: false,
    requesterVerifiedUntil: null,
    state: "NotSent",
    approvalReference: null,
    approvedAt: null,
    approverName: null,
    canApprove: false,
    soleOperatorApproval: false,
  };
  let canSend = true;
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: false,
        canSend,
        soleOperator: null,
        entries: [asked],
      },
    }),
  );
  await page.goto("/app");
  const line = page.locator(".overview-attention li", { hasText: "Refunds not sent yet" });
  await expect(line).toContainText("1 asked by staff, waiting for you to send");
  await page.goto("/app/approvals");
  await expect(page.getByText("Asked by Mia, waiting for you to send")).toBeVisible();
  await expect(
    page.getByText("Recorded, not sent yet. The guest has not been refunded."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send refund" })).toBeVisible();
  await expectNoInternalText(page);
  await noHorizontalScroll(page, "approvals-not-sent-manager");
  // Someone who may not send it is told who does.
  canSend = false;
  await page.reload();
  await expect(page.getByText("A manager or the owner sends it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send refund" })).toHaveCount(0);
  await noHorizontalScroll(page, "approvals-not-sent-cashier");
});

test("@production M163: a manager records money taken back after a refund made by mistake", async ({
  page,
}) => {
  await signIn(page);
  await noApprovals(page);
  let recoveries: Record<string, unknown>[] = [];
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({
      headers,
      json: context({ confirmedRefundMinor: "3000", canRecover: true, recoveries }),
    }),
  );
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        orderNumber: "21",
        canRequest: true,
        canWithdraw: true,
        claimVersion: 0,
        recentRequests: [],
        items: [],
      },
    }),
  );
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/merchant/payments/refunds/recover", (route) => {
    const command = JSON.parse(route.request().postData() ?? "{}");
    bodies.push(command);
    const recovery = {
      recoveryReference: id(70),
      method: command.method,
      amountMinor: command.amountMinor,
      currencyCode: "CAD",
      reasonCode: command.reasonCode,
      businessDate: "2026-11-10",
      recordedAt: "2026-11-10T12:05:00.000Z",
      recordedByName: "Sam",
    };
    recoveries = [recovery];
    return route.fulfill({
      headers,
      json: { status: "Recorded", orderReference: id(1), recovery },
    });
  });
  await page.goto("/app/operations/payments/" + id(31));
  await page.getByRole("button", { name: "Take money back" }).click();
  await page.getByLabel(/Amount \(up to \$30\.00\)/).fill("5");
  await page.getByRole("checkbox", { name: /This adds a record/ }).check();
  await noHorizontalScroll(page, "money-taken-back-form");
  await page.getByRole("button", { name: "Record money taken back" }).click();
  await expect(page.getByText("Recorded: $5.00 taken back.")).toBeVisible();
  expect(bodies[0]).toMatchObject({
    orderReference: id(1),
    method: "Cash",
    amountMinor: "500",
    reasonCode: "REFUNDED_TOO_MUCH",
  });
  await expect(page.getByText("Money taken back +$5.00 · Cash · Sam")).toBeVisible();
  await expectNoInternalText(page);
  await noHorizontalScroll(page, "money-taken-back-listed");
});

test("@production M10: the cook's ticket strikes through the refunded units and says who refunded them", async ({
  page,
}) => {
  await noApprovals(page);
  const at = new Date().toISOString();
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
          businessDate: "2026-11-10",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "KIT-KITCHEN-QUEUE",
              label: "Kitchen",
              href: "/operations/kitchen",
              permission: "kitchen.operate",
            },
          ],
        },
      },
    }),
  );
  const item = (n: number, name: string, required: number, refund: Record<string, unknown>) => ({
    workItemReference: id(400 + n),
    ticketReference: id(450 + n),
    orderReference: id(470 + n),
    orderItemReference: id(420 + n),
    stationReference: id(52),
    localizedDisplayNames: { "zh-Hans": name },
    allergens: { status: "Unavailable" },
    orderLabel: { orderNumber: String(30 + n), orderType: "Pickup", tableLabel: null },
    customerNote: null,
    selectedOptions: [],
    status: "In Progress",
    requiredQuantity: required,
    completedQuantity: 0,
    workItemCreatedAt: at,
    acceptedAt: at,
    orderItemReadyAt: null,
    ticketAggregateVersion: "7",
    workItemVersion: "3",
    ...refund,
  });
  await page.route("**/merchant/kitchen/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        operatorStatus: "Named",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(6),
        projectedAt: at,
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        items: [
          // Being made, 1 of 2 refunded by Mia: 2× struck through, 1× still to make.
          item(1, "担担面", 2, { refundedQuantity: 1, refundedBy: ["Mia"] }),
          // Being made, refunded in full: stop, and clear it with Finished.
          item(2, "炒饭", 1, { refundedQuantity: 1, refundedBy: ["Mia"] }),
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/operations/kitchen");
  const partly = page.locator(".kitchen-ticket").filter({ hasText: "担担面" });
  await expect(partly.locator(".kitchen-work-item__count-refunded")).toHaveText("2×");
  await expect(partly.locator(".kitchen-work-item__count")).toContainText("1×");
  await expect(partly).toContainText("1 refunded · don't make it · make 1 · Refunded by Mia");
  const stopped = page.locator(".kitchen-ticket").filter({ hasText: "炒饭" });
  await expect(stopped).toContainText(
    "Refunded · stop, don't make it · press Finished to clear it · Refunded by Mia",
  );
  const strike = await partly
    .locator(".kitchen-work-item__count-refunded")
    .evaluate((node) => getComputedStyle(node).textDecorationLine);
  expect(strike).toContain("line-through");
  await expectNoInternalText(page);
  await noHorizontalScroll(page, "kitchen-refunded-struck-through");
});

test("@production M10: a refund that needs the owner's approval does not stop the kitchen, and a refused stop says why", async ({
  page,
}) => {
  await signIn(page);
  await noApprovals(page);
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({ headers, json: context({ capturedAmountMinor: "30000" }) }),
  );
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        orderNumber: "21",
        canRequest: true,
        canWithdraw: true,
        claimVersion: 0,
        recentRequests: [],
        items: [
          {
            orderBatchReference: id(90),
            orderItemReference: id(3),
            label: "Catering tray",
            quantity: 2,
            unclaimedQuantity: 2,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: id(31),
            paymentMethod: "Online",
            kitchen: "NotStarted",
            withdrawnQuantity: 0,
          },
        ],
      },
    }),
  );
  let approvalRequired = true;
  await page.route("**/merchant/payments/refunds/preview", (route) => {
    const command = JSON.parse(route.request().postData() ?? "{}");
    return route.fulfill({
      headers,
      json: {
        status: "Previewed",
        requestReference: command.requestReference,
        operationReference: command.operationReference,
        claimVersion: 0,
        currencyCode: "CAD",
        amountMinor: "15000",
        paymentAttemptReferences: [id(32)],
        approvalRequired,
        escalationReasons: approvalRequired ? ["OrderOrdinaryTotalAboveCad100"] : [],
        approveAlone: false,
        components: {
          netAmountMinor: "13274",
          taxAmountMinor: "1726",
          tipAmountMinor: "0",
          serviceChargeAmountMinor: "0",
          serviceChargeTaxAmountMinor: "0",
        },
      },
    });
  });
  await page.route("**/merchant/payments/refunds/request", (route) =>
    route.fulfill({ status: 409, headers, json: { error: "refund_withdraw_everything" } }),
  );
  await page.goto("/app/operations/payments/" + id(31) + "/refund");
  await page.getByRole("spinbutton", { name: /Catering tray/ }).fill("1");
  await expect(page.getByRole("checkbox", { name: /Stop making it too/ })).toBeChecked();
  await page.getByRole("combobox", { name: "Reason" }).selectOption("WRONG_ITEM");
  await page.getByRole("button", { name: "Review refund" }).click();
  const review = page.getByRole("region", { name: "Review this refund" });
  await expect(review).toContainText(
    "This refund needs the owner's approval, so the kitchen isn't told now.",
  );
  await page.getByRole("checkbox", { name: /I confirm/ }).check();
  await expect(
    page.getByRole("button", { name: "Record request for owner approval" }),
  ).toBeDisabled();
  await expectNoInternalText(page);
  await noHorizontalScroll(page, "refund-stop-needs-approval");
  // Without approval: the refund is sent, and a stop the server refuses says why.
  approvalRequired = false;
  await page.getByRole("button", { name: "Review refund" }).click();
  await expect(review).not.toContainText("the kitchen isn't told now");
  await page.getByRole("checkbox", { name: /I confirm/ }).check();
  await page.getByRole("button", { name: /Send \$150\.00 refund/ }).click();
  await expect(page.locator(".refund-status")).toContainText(
    "Nothing was recorded. This would refund and stop every dish of the pickup",
  );
  await noHorizontalScroll(page, "refund-stop-refused");
});
