import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * v15 batch 8 (dining-service-api, print-orders-records): a paid round left unaccepted for 5
 * minutes tells staff what to do with the button they actually have on the order: a manager's
 * "Refuse and refund", a cashier's "Can't make it · refund", and never a name that is not on
 * screen. Synthetic HTTP on the built page at 1440, 1024 and 390.
 */
const id = (n: number) => "0190997a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
    orderType: "DineIn",
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
        awaitingAcceptanceSince: new Date(Date.now() - 6 * 60_000)
          .toISOString()
          .replace(/\.\d{3}Z$/u, ".000Z"),
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
async function orders(page: Page, who: "Manager" | "Cashier") {
  const listed = () => ({ items: [order(false, who, true)], nextAfterOrderReference: null });
  await page.route("**/merchant/orders?*", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders/detail?*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: order(true, who, true),
        paymentPosition: {
          refundedMinor: "0",
          refundPendingMinor: "0",
          refundNotSentMinor: "0",
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
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: who === "Manager",
        soleOperator: null,
        entries: [],
      },
    }),
  );
}

for (const [who, button, other] of [
  ["Manager", "Refuse and refund", "Can't make it · refund"],
  ["Cashier", "Can't make it · refund", "Refuse and refund"],
] as const)
  test(`@production a paid round waiting 6 min names the ${who.toLowerCase()}'s own button`, async ({
    page,
  }) => {
    await signIn(page);
    await orders(page, who);
    await page.goto("/operations/orders/" + id(21));
    await expect(page.getByRole("button", { name: button, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: other, exact: true })).toHaveCount(0);
    const guidance = page.getByText(/^Accept now · paid 6 min ago\./u);
    await expect(guidance).toBeVisible();
    await expect(guidance).toContainText(
      `If it can't be made, use ${button}: the guest gets a full refund.`,
    );
    await expect(guidance).not.toContainText(other);
    await expectNoInternalText(page);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expect(guidance).toBeVisible();
      await page.screenshot({
        path: `test-results/order-paid-round-guidance-${who}-${width}.png`,
        fullPage: true,
      });
    }
  });
