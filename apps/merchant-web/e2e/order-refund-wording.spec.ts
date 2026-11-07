import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 M10/M14/M16: on a paid order waiting for acceptance, a manager refuses it with Refuse
 * and refund and a cashier with Can't make it; an order refunded in full is closed with the control
 * the reader actually has. A refund recorded and waiting for approval says so on the order instead
 * of offering a send the payment page can't do.
 */
const id = (n: number) => "0190996f-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
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
          businessDate: "2026-11-06",
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
}
function order(
  detail: boolean,
  who: "Manager" | "Cashier",
  waiting: boolean,
): Record<string, unknown> {
  return {
    orderReference: id(21),
    orderNumber: "21",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-11-06T15:00:00.000Z",
    observedAt: "2026-11-06T15:01:00.000Z",
    initialBatchReference: id(91),
    batches: [
      {
        orderBatchReference: id(91),
        sequence: 1,
        acceptanceStatus: waiting ? "NotAccepted" : "Accepted",
        canRequestAcceptance: waiting,
        // The server's rule: a manager has the general cancel, a cashier who may accept has
        // Can't make it on a paid order waiting for acceptance.
        canCancel: who === "Manager",
        canCantMake: who === "Cashier" && waiting,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: waiting,
    currentPhase: waiting ? "Submitted" : "Accepted",
    currentVersion: waiting ? 1 : 2,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    paidOnline: money("3137"),
    canRecordCardMachinePayment: false,
    canViewPayments: who === "Manager",
    ...(detail ? { kitchenPhase: null } : {}),
  };
}
async function orders(
  page: Page,
  state: { who: "Manager" | "Cashier"; waiting: boolean; notSentMinor: string },
) {
  const listed = () => ({
    items: [order(false, state.who, state.waiting)],
    nextAfterOrderReference: null,
  });
  await page.route("**/merchant/orders?*", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders/detail?*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: order(true, state.who, state.waiting),
        paymentPosition: {
          refundedMinor: "0",
          refundPendingMinor: state.notSentMinor,
          refundNotSentMinor: state.notSentMinor,
          refundOnMachineMinor: "0",
        },
        lines: {
          items: [
            {
              orderItemReference: id(201),
              orderBatchReference: id(91),
              name: "Beef noodle soup",
              options: [],
              quantity: 1,
              customerNote: null,
              unitPrice: money("2600"),
              subtotal: money("2600"),
              discount: money("0"),
              tax: money("338"),
              fee: money("0"),
              total: money("2938"),
              canCancel: false,
              cancellation: null,
            },
          ],
          totals: {
            subtotal: money("2600"),
            discount: money("0"),
            tax: money("338"),
            fee: money("0"),
            total: money("2938"),
            tip: money("199"),
          },
        },
      },
    }),
  );
  // Every dish was refunded already: the server refuses acceptance as fully refunded.
  await page.route("**/merchant/orders/accept", (route) =>
    route.fulfill({
      status: 409,
      headers,
      json: { error: "order_not_acceptable", reason: "fully_refunded" },
    }),
  );
}
async function widths(page: Page, name: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("@production a manager refuses a refunded waiting order with Refuse and refund, and is told so", async ({
  page,
}) => {
  await signIn(page);
  await orders(page, { who: "Manager", waiting: true, notSentMinor: "0" });
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: true,
        soleOperator: null,
        entries: [],
      },
    }),
  );
  await page.goto("/operations/orders/" + id(21));
  await expect(page.getByRole("button", { name: "Refuse and refund" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Can't make it · refund" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Accept/u }).click();
  await expect(
    page.getByText("This order was refunded in full. Close it with Refuse and refund."),
  ).toBeVisible();
  await expect(page.getByText("Close it with Can't make it")).toHaveCount(0);
  await expectNoInternalText(page);
  await widths(page, "order-refunded-manager");
});

test("@production a cashier closes a refunded waiting order with Can't make it, and is told so", async ({
  page,
}) => {
  await signIn(page);
  await orders(page, { who: "Cashier", waiting: true, notSentMinor: "0" });
  await page.goto("/operations/orders/" + id(21));
  await expect(page.getByRole("button", { name: "Can't make it · refund" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refuse and refund" })).toHaveCount(0);
  await expect(page.getByText("Ask the manager or owner for refunds.")).toBeVisible();
  await page.getByRole("button", { name: /^Accept/u }).click();
  await expect(
    page.getByText("This order was refunded in full. Close it with Can't make it."),
  ).toBeVisible();
  await expectNoInternalText(page);
  await widths(page, "order-refunded-cashier");
});

test("@production a refund waiting for approval says so on the order, not 'open the payment to send it'", async ({
  page,
}) => {
  await signIn(page);
  await orders(page, { who: "Manager", waiting: false, notSentMinor: "3137" });
  let entries: Record<string, unknown>[] = [
    {
      orderReference: id(21),
      orderNumber: "21",
      requestReference: id(301),
      paymentIntentReferences: [id(401)],
      paymentMethod: "Online",
      currencyCode: "CAD",
      amountMinor: "3137",
      reasonCode: "WRONG_ITEM",
      note: null,
      escalationReasons: ["OrderOrdinaryTotalAboveCad100"],
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
      requesterName: "Mia",
      requestedByYou: true,
      requesterVerifiedUntil: new Date(Date.now() + 14 * 60_000).toISOString(),
      state: "AwaitingApproval",
      approvalReference: null,
      approvedAt: null,
      approverName: null,
      canApprove: false,
      soleOperatorApproval: false,
    },
  ];
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: false,
        soleOperator: null,
        entries,
      },
    }),
  );
  await page.goto("/operations/orders/" + id(21));
  const note = page.locator(".order-online-refunds").first();
  await expect(note).toContainText(
    "A refund of $31.37 is recorded and waiting for approval. It is sent once it is approved under Approvals.",
  );
  await expect(note).not.toContainText("to send it");
  await expectNoInternalText(page);
  await widths(page, "order-refund-waiting-approval");
  // Nothing in the approval queue for it: it is recorded and sent from the payment's page.
  entries = [];
  await page.reload();
  await expect(note).toContainText(
    "A refund of $31.37 is recorded but not sent yet. Open the payment under Payments and refunds to send it.",
  );
});
