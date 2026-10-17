import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 Q6 step 2 (DEC-TIP-REFUND-PROPORTIONAL, Owner 2026-10-17): a store manager cancels one
 * item of a paid pickup order with a tip. The dialog states the refund the server previewed — the
 * item, its tax and its share of the tip — before anything is cancelled; after the cancellation the
 * order is re-read and the line shows the refund that includes that tip share.
 */
test("@production cancelling paid items previews and refunds their share of the tip", async ({
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
          businessDate: "2026-10-17",
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
  let cancelled = false;
  // 46940b76 L2/L3: then the last item is cancelled, which cancels the whole order.
  let ended = false;
  const order = () => ({
    orderReference: id(20),
    orderNumber: "20",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-17T15:00:00.000Z",
    observedAt: "2026-10-17T15:01:00.000Z",
    initialBatchReference: id(90),
    batches: [
      {
        orderBatchReference: id(90),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: !ended,
        staffCancellation: ended
          ? {
              reasonCode: "SOLD_OUT",
              cancelledAt: "2026-10-17T15:07:00.000Z",
              refundStatus: "Refunded",
              refundMethod: "Online",
              refundAmountMinor: "712",
            }
          : null,
        canCancelItems: !ended,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: ended ? "Cancelled" : "Accepted",
    currentVersion: ended ? 4 : cancelled ? 3 : 2,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    paidOnline: money("1424"),
  });
  const line = (n: number, name: string, net: string, tax: string, total: string) => ({
    orderItemReference: id(200 + n),
    orderBatchReference: id(90),
    name,
    options: [],
    quantity: 1,
    customerNote: null,
    unitPrice: money(net),
    subtotal: money(net),
    discount: money("0"),
    tax: money(tax),
    fee: money("0"),
    total: money(total),
    canCancel: !ended && (!cancelled || n === 2),
    cancellation:
      cancelled && n === 1
        ? {
            reasonCode: "SOLD_OUT",
            cancelledAt: "2026-10-17T15:05:00.000Z",
            refundStatus: "Refunded",
            // The line's refund as Payment's claim returned it: 5.75 + 0.75 tax + 0.62 tip
            // (half of the 1.24 tip: the two lines' nets are equal).
            refund: money("712"),
          }
        : null,
  });
  await page.route("**/merchant/orders?*", (route) => route.fulfill({ headers, json: listed() }));
  const listed = () => ({ items: [order()], nextAfterOrderReference: null });
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders/detail?*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: order(),
        paymentPosition: {
          refundedMinor: ended ? "1424" : cancelled ? "712" : "0",
          refundPendingMinor: "0",
        },
        lines: {
          items: [
            line(1, "Mocha", "575", "75", "650"),
            line(2, "Synthetic croissant", "575", "75", "650"),
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
  await page.route("**/merchant/orders/cancel-items/preview", (route) => {
    previews.push(route.request().postDataJSON());
    // The last item: the whole remaining payment, with the tip left on it (the other half).
    if (cancelled)
      return route.fulfill({
        headers,
        json: {
          scope: "Batch",
          refund: {
            amountMinor: "712",
            currencyCode: "CAD",
            includesTip: true,
            netAmountMinor: "0",
            taxAmountMinor: "0",
            tipAmountMinor: "62",
          },
        },
      });
    return route.fulfill({
      headers,
      json: {
        scope: "Items",
        refund: {
          amountMinor: "712",
          currencyCode: "CAD",
          includesTip: true,
          netAmountMinor: "575",
          taxAmountMinor: "75",
          tipAmountMinor: "62",
        },
      },
    });
  });
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/cancel-items", (route) => {
    const command = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(command);
    if (cancelled) {
      ended = true;
      return route.fulfill({
        headers,
        json: {
          status: "Cancelled",
          scope: "Batch",
          orderReference: id(20),
          orderBatchReference: id(90),
          cancellationReference: id(701),
          orderItemReferences: [id(202)],
          cancelledAt: "2026-10-17T15:07:00.000Z",
          refund: { status: "Pending", amountMinor: "712", currencyCode: "CAD", includesTip: true },
        },
      });
    }
    cancelled = true;
    return route.fulfill({
      headers,
      json: {
        status: "Cancelled",
        scope: "Items",
        orderReference: id(20),
        orderBatchReference: id(90),
        cancellationReference: id(700),
        orderItemReferences: [id(201)],
        cancelledAt: "2026-10-17T15:05:00.000Z",
        refund: { status: "Refunded", amountMinor: "712", currencyCode: "CAD", includesTip: true },
      },
    });
  });
  await page.goto("/operations/orders");
  const entry = page.locator("details.order-workbench-entry").first();
  await expect(entry).toContainText("Paid online $14.24");
  if (!(await entry.evaluate((element) => (element as HTMLDetailsElement).open)))
    await entry.locator("summary").click();
  // Items are chosen on the order's own page, from its lines.
  await entry.getByRole("link", { name: "Cancel items" }).click();
  await page.getByRole("button", { name: "Cancel items" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel items from order 20" });
  await expect(dialog).toContainText(
    "The customer is refunded for the cancelled items, their tax and their share of any tip",
  );
  await dialog.getByRole("checkbox", { name: /1 × Mocha/u }).check();
  await expect(dialog.locator(".order-item-cancel-refund")).toHaveText(
    "Refund $7.12 (items, tax and $0.62 of the tip).",
  );
  await dialog.getByRole("combobox", { name: "Reason" }).selectOption("SOLD_OUT");
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/item-cancel-tip-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole("button", { name: "Cancel item and refund" }).click();
  await expect(dialog).toBeHidden();
  // The order is re-read: the line's refund and the order's refund total include the tip share.
  await expect(page.getByText("Cancelled · refunded · $7.12")).toBeVisible();
  await expect(page.getByText("Cancelled items refund")).toBeVisible();
  await expect(page.getByText("−$7.12")).toBeVisible();
  await page.screenshot({ path: "test-results/item-cancel-tip-after.png" });
  await expectNoInternalText(page);

  // 46940b76 L3: cancelling the last item says how much of the tip the rest of the payment returns.
  await page.getByRole("button", { name: "Cancel items" }).click();
  await dialog.getByRole("checkbox", { name: /1 × Synthetic croissant/u }).check();
  await expect(dialog.locator(".order-item-cancel-refund")).toHaveText(
    "These are the last items: the whole order is cancelled and the remaining payment of $7.12 is refunded, including $0.62 of the tip.",
  );
  await dialog.getByRole("combobox", { name: "Reason" }).selectOption("SOLD_OUT");
  await dialog.getByRole("button", { name: "Cancel order and refund" }).click();
  await expect(dialog).toBeHidden();
  // 46940b76 L2: every refund is listed and they add up to what was refunded.
  const refunds = page.locator(".order-lines-cancelled-refund");
  await expect(refunds).toContainText("Cancelled items refund−$7.12");
  await expect(refunds).toContainText("Order cancellation refund−$7.12");
  await expect(refunds).toContainText("Total refunded−$14.24");
  await expect(page.getByText("Refunded $14.24 of the online payment.")).toBeVisible();
  await page.screenshot({ path: "test-results/item-cancel-whole-after.png" });
  await expectNoInternalText(page);
  expect(previews).toEqual([
    {
      orderReference: id(20),
      orderBatchReference: id(90),
      orderItemReferences: [id(201)],
      expectedOrderVersion: 2,
    },
    {
      orderReference: id(20),
      orderBatchReference: id(90),
      orderItemReferences: [id(202)],
      expectedOrderVersion: 3,
    },
  ]);
  expect(commands).toEqual([
    {
      orderReference: id(20),
      orderBatchReference: id(90),
      orderItemReferences: [id(201)],
      expectedOrderVersion: 2,
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      reasonCode: "SOLD_OUT",
    },
    {
      orderReference: id(20),
      orderBatchReference: id(90),
      orderItemReferences: [id(202)],
      expectedOrderVersion: 3,
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      reasonCode: "SOLD_OUT",
    },
  ]);
});
