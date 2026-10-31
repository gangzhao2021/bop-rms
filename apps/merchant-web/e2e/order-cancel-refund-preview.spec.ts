import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 (v15 2026-10-18): the whole-order cancel dialog states what the cancellation refunds as
 * the server reads it — nothing more for an order already refunded in full, the remaining amount
 * after a partial refund — and a pickup offers no "Guests left" reason: a customer who never came
 * is closed as not collected in Pickup. The order's own page reads "Ready for pickup" as soon as
 * the kitchen finishes, before Ordering records it.
 */
test("@production the cancel dialog says what is refunded and the detail follows the kitchen", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
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
          businessDate: "2026-10-18",
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
  let refunded = "1424";
  let kitchenPhase: "Ready" | null = null;
  const order = (detail: boolean) => ({
    orderReference: id(21),
    orderNumber: "21",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-18T15:00:00.000Z",
    observedAt: "2026-10-18T15:01:00.000Z",
    initialBatchReference: id(91),
    batches: [
      {
        orderBatchReference: id(91),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: kitchenPhase === null,
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
    paidOnline: money("1424"),
    ...(detail ? { kitchenPhase } : {}),
  });
  const listed = () => ({ items: [order(false)], nextAfterOrderReference: null });
  await page.route("**/merchant/orders?*", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders/detail?*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: order(true),
        paymentPosition: { refundedMinor: refunded, refundPendingMinor: "0" },
        lines: {
          items: [
            {
              orderItemReference: id(201),
              orderBatchReference: id(91),
              name: "Mocha",
              options: [],
              quantity: 2,
              customerNote: null,
              unitPrice: money("575"),
              subtotal: money("1150"),
              discount: money("0"),
              tax: money("150"),
              fee: money("0"),
              total: money("1300"),
              canCancel: false,
              cancellation: null,
            },
          ],
          totals: {
            subtotal: money("1150"),
            discount: money("0"),
            tax: money("150"),
            fee: money("0"),
            total: money("1300"),
            tip: money("124"),
          },
        },
      },
    }),
  );
  const previews: unknown[] = [];
  await page.route("**/merchant/orders/cancel/preview", (route) => {
    previews.push(route.request().postDataJSON());
    return route.fulfill({
      headers,
      json: {
        orderReference: id(21),
        orderBatchReference: id(91),
        refundMethod: "Online",
        paidMinor: "1424",
        refundMinor: (1424 - Number(refunded)).toString(),
        currencyCode: "CAD",
      },
    });
  });
  await page.goto("/operations/orders/" + id(21));
  await page.getByRole("button", { name: "Cancel order" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel order 21" });
  // Already refunded in full by an ordinary refund: nothing more is refunded.
  await expect(dialog.locator(".order-cancel-refund")).toHaveText(
    "This order was already refunded in full; nothing more will be refunded.",
  );
  await expect(dialog).not.toContainText("including tip");
  const reasons = dialog.getByRole("combobox", { name: "Reason" }).locator("option");
  await expect(reasons).toHaveText([
    "Select a reason",
    "Customer request",
    "Sold out",
    "Store error",
    "Duplicate order",
  ]);
  await expect(dialog.locator(".order-cancel-no-show")).toContainText(
    "close it as not collected in Pickup",
  );
  await expect(dialog.getByRole("link", { name: "Pickup" })).toHaveAttribute(
    "href",
    "/operations/pickup",
  );
  await dialog.getByRole("combobox", { name: "Reason" }).selectOption("CUSTOMER_REQUEST");
  await expect(dialog.getByRole("button", { name: "Cancel order", exact: true })).toBeVisible();
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/order-cancel-nothing-more-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole("button", { name: "Keep order" }).click();
  await expect(dialog).toBeHidden();

  // Partly refunded: the dialog states what was refunded and the remaining amount.
  refunded = "694";
  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(dialog.locator(".order-cancel-refund")).toHaveText(
    "$6.94 was already refunded. The customer is refunded the remaining $7.30.",
  );
  await dialog.getByRole("combobox", { name: "Reason" }).selectOption("SOLD_OUT");
  await expect(dialog.getByRole("button", { name: "Cancel order and refund" })).toBeVisible();
  await page.screenshot({ path: "test-results/order-cancel-remaining.png" });
  await dialog.getByRole("button", { name: "Keep order" }).click();
  expect(previews).toEqual([
    { orderReference: id(21), orderBatchReference: id(91), expectedOrderVersion: 3 },
    { orderReference: id(21), orderBatchReference: id(91), expectedOrderVersion: 3 },
  ]);

  // The kitchen finished: the order's page reads Ready for pickup while Ordering still says
  // Accepted (the list keeps Ordering's phase).
  kitchenPhase = "Ready";
  await page.reload();
  await expect(page.locator(".order-workbench-phase").first()).toHaveText("Ready for pickup");
  await page.screenshot({ path: "test-results/order-detail-kitchen-ready.png" });
  await expectNoInternalText(page);
});
