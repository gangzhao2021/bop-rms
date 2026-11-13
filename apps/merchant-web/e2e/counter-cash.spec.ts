import { expect, test, type Page } from "@playwright/test";
import { orderPanel } from "./order-queue-helpers";

// WP-2423 M52 (DEC-COUNTER-CASH, Owner default 2026-11-06): a walk-up or pickup order at the counter
// is paid in cash by the table's cash rules — the cash total rounded to 5 cents, the cash handed
// over and the change — and a cancelled cash order is given back in cash from the drawer.
const id = (n: number) => "01909978-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const price = (amount: string) => ({ status: "Available", amount, currency: "CAD", reason: null });
const menu = {
  screenId: "OPS-ORDER-ENTRY",
  menu: {
    status: "Found",
    schemaVersion: 1,
    projection: {},
    scope: {},
    menu: {
      menuReference: id(1),
      menuVersionReference: id(2),
      releaseReference: id(3),
      locale: "en-CA",
      name: "Menu",
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(4),
          name: "Coffee",
          sellables: [
            {
              sellableReference: id(5),
              productVersionReference: id(6),
              name: "Flat White",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [
                {
                  name: "Milk",
                  bindingReference: id(7),
                  optionSetVersionReference: id(8),
                  minimumSelections: 1,
                  maximumSelections: 1,
                  enabledOptionReferences: [id(9), id(10)],
                  defaultOptionReferences: [id(9)],
                  options: [
                    {
                      optionReference: id(9),
                      name: "Whole milk",
                      maximumQuantity: 1,
                      conflictOptionReferences: [],
                      selectedByDefault: true,
                      incrementalPrice: price("0.00"),
                    },
                    {
                      optionReference: id(10),
                      name: "Oat milk",
                      maximumQuantity: 1,
                      conflictOptionReferences: [],
                      selectedByDefault: false,
                      incrementalPrice: price("0.75"),
                    },
                  ],
                },
              ],
              allergenDisclosure: {},
              displayPrice: price("4.50"),
              taxDisplayContext: {},
            },
            {
              sellableReference: id(11),
              productVersionReference: id(12),
              name: "Butter Croissant",
              presentationRole: "Standard",
              pinned: false,
              availability: "SoldOut",
              optionRules: [],
              allergenDisclosure: {},
              displayPrice: price("3.25"),
              taxDisplayContext: {},
            },
            {
              sellableReference: id(13),
              productVersionReference: id(14),
              name: "Banana Bread",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {},
              displayPrice: price("3.75"),
              taxDisplayContext: {},
            },
          ],
        },
      ],
    },
  },
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
          businessDate: "2026-10-13",
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
              screenId: "OPS-ORDER-ENTRY",
              label: "Counter order",
              href: "/operations/order-entry",
              permission: "ordering.order.create_staff",
            },
          ],
        },
      },
    }),
  );
}

test("@production the cashier takes cash for a counter order, sees the change and records it", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  await page.route("**/merchant/counter/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "15",
        orderVersion: 1,
        // Banana Bread $3.75 with tax: $4.24 → $4.25 in cash.
        orderMinor: "424",
        tipMinor: "0",
        totalMinor: "424",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    }),
  );
  const payments: Record<string, unknown>[] = [];
  let shortOnce = true;
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    payments.push(body);
    if (shortOnce && body.tenderedMinor === "1000") {
      // The server applies the same rule and refuses a short amount (here: forced once).
      shortOnce = false;
      return route.fulfill({ status: 409, headers, json: { error: "cash_tender_short" } });
    }
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(20),
        orderBatchReference: id(21),
        amountMinor: "424",
        recordingReason: "AtCounter",
        takenAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        cash: {
          cashTotalMinor: "425",
          roundingMinor: "1",
          tenderedMinor: body.tenderedMinor,
          changeMinor: String(Number(body.tenderedMinor) - 425),
        },
        acceptance: "Accepted",
      },
    });
  });

  await page.goto("/operations/order-entry");
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $4.24 on the card machine" }),
  ).toBeVisible();
  const how = page.getByRole("group", { name: "How the guest pays" });
  await how.getByRole("radio", { name: "Cash" }).check();
  await expect(page.getByRole("heading", { name: "Take $4.25 in cash" })).toBeVisible();
  await expect(page.locator(".counter-order__charge")).toContainText(
    "Cash total (rounded to 5 cents)$4.25",
  );
  await expect(
    page.getByText("Sent. Take $4.25 in cash with tax and tip (rounded to 5 cents)."),
  ).toBeVisible();
  // No card slip for cash.
  await expect(page.getByRole("textbox", { name: "Slip reference (optional)" })).toHaveCount(0);
  const received = page.getByRole("textbox", { name: "Cash received" });
  const record = page.getByRole("button", { name: "Cash received · $4.25" });
  await expect(record).toBeDisabled();
  await received.fill("4");
  await expect(page.getByText("$0.25 short")).toBeVisible();
  await expect(record).toBeDisabled();
  // The usual amounts are one tap: the exact cash total, then the next bills.
  await page.getByRole("button", { name: "$10.00", exact: true }).click();
  await expect(received).toHaveValue("10.00");
  await expect(page.getByText("Change $5.75")).toBeVisible();

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("heading", { name: "Take $4.25 in cash" })).toBeVisible();
    await expect(page.getByText("Change $5.75")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/counter-cash-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // A refusal says why in plain words; nothing was recorded, and staff count again.
  await record.click();
  await expect(page.getByRole("alert")).toContainText(
    "The cash received is less than the cash total.",
  );
  await received.fill("20");
  await expect(page.getByText("Change $15.75")).toBeVisible();
  await page.getByRole("button", { name: "Cash received · $4.25" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Cash recorded. Give $15.75 change. Sent to the kitchen." }),
  ).toBeVisible();
  await expect(page.locator(".counter-order__charge")).toContainText("Change to give$15.75");
  await expect(page.getByText("Sent and paid in cash: $4.25 with tax and tip.")).toBeVisible();
  // The browser sends the cash handed over; the amount and the rounding are the server's.
  expect(payments.at(-1)).toEqual({
    operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    orderReference: id(20),
    orderBatchReference: id(21),
    expectedTotalMinor: "424",
    slipReference: null,
    takenAt: null,
    tenderedMinor: "2000",
  });
  // A different amount handed over is a different payment intent (a new operation).
  expect(payments[0]?.operationReference).not.toBe(payments.at(-1)?.operationReference);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/counter-cash-paid-${width}.png`, fullPage: true });
  }
});

test("@production a cancelled cash counter order is given back in cash from the drawer, no card slip", async ({
  page,
}) => {
  await signIn(page);
  let refunded = false;
  const row = () => ({
    orderReference: id(30),
    orderNumber: "15",
    orderType: "Pickup",
    sourceChannel: "Pos",
    submittedAt: "2026-10-13T16:00:00.000Z",
    observedAt: "2026-10-13T16:20:00.000Z",
    initialBatchReference: id(31),
    counter: {
      recordedAfterOutage: false,
      paidOnCardMachine: {
        amountMinor: "425",
        takenAt: "2026-10-13T16:01:00.000Z",
        recordedAfterOutage: false,
        refundedMinor: refunded ? "425" : "0",
        cash: { tenderedMinor: "2000", changeMinor: "1575", roundingMinor: "1" },
      },
    },
    batches: [
      {
        orderBatchReference: id(31),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: {
          reasonCode: "CUSTOMER_REQUEST",
          cancelledAt: "2026-10-13T16:10:00.000Z",
          refundStatus: refunded ? "Refunded" : "Pending",
          refundMethod: "CardMachine",
          refundAmountMinor: "425",
        },
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: "Cancelled",
    currentVersion: 3,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  const listed = () => ({ items: [row()], nextAfterOrderReference: null });
  await page.route("**/merchant/orders?*", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: listed() }));
  const refunds: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/card-machine-refund", (route) => {
    refunds.push(route.request().postDataJSON() as Record<string, unknown>);
    refunded = true;
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(30),
        orderBatchReference: id(31),
        amountMinor: "425",
        refundedAt: new Date().toISOString(),
      },
    });
  });
  await page.goto("/operations/orders");
  const listedRow = page.locator("li.order-row").first();
  await expect(listedRow).toContainText("Cancelled by store · give back cash");
  await expect(listedRow).toContainText("Cash");
  // Orders opens the only order on the page beside the list by itself.
  await expect(listedRow).toHaveAttribute("data-open", "true");
  const entry = orderPanel(page);
  await expect(entry).toContainText("Paid in cash $4.25 · change $15.75");
  await expect(entry).toContainText("Cancelled by store · give back cash");
  await expect(entry.getByText("Give back $4.25 in cash, then record it here.")).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-cash-refund-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await entry.getByRole("button", { name: "Record cash given back" }).click();
  const dialog = page.getByRole("dialog", { name: "Give back $4.25 in cash" });
  await expect(dialog).toContainText("whole nickels");
  await expect(dialog.getByRole("textbox", { name: "Slip reference (optional)" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Gave back $4.25 in cash" }).click();
  await expect(entry).toContainText("Cancelled by store · cash given back");
  expect(refunds).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      orderReference: id(30),
      orderBatchReference: id(31),
      slipReference: null,
      refundedAt: null,
    },
  ]);
});

test("@production after a reload the cashier takes cash for a sent counter order from the list", async ({
  page,
}) => {
  await signIn(page);
  const payBy = new Date(Date.now() + 20 * 60_000).toISOString();
  const row = (amountDueMinor: string | null) => ({
    orderReference: id(60),
    orderNumber: "21",
    orderType: "Pickup",
    sourceChannel: "Pos",
    submittedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    observedAt: new Date().toISOString(),
    initialBatchReference: id(61),
    counter: { recordedAfterOutage: false, paidOnCardMachine: null, payBy, amountDueMinor },
    canRecordCardMachinePayment: true,
    canViewPayments: false,
    batches: [
      {
        orderBatchReference: id(61),
        sequence: 1,
        acceptanceStatus: "NotAccepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: "Submitted",
    currentVersion: 1,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: true,
  });
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({ headers, json: { items: [row(null)], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail?*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: row("1133"),
        lines: {
          items: [
            {
              orderItemReference: id(62),
              orderBatchReference: id(61),
              name: "Flat White",
              options: [],
              quantity: 2,
              customerNote: null,
              unitPrice: { amountMinor: "450", currencyCode: "CAD" },
              subtotal: { amountMinor: "900", currencyCode: "CAD" },
              discount: { amountMinor: "0", currencyCode: "CAD" },
              tax: { amountMinor: "117", currencyCode: "CAD" },
              fee: { amountMinor: "0", currencyCode: "CAD" },
              total: { amountMinor: "1017", currencyCode: "CAD" },
              canCancel: false,
              cancellation: null,
            },
          ],
          totals: {
            subtotal: { amountMinor: "900", currencyCode: "CAD" },
            discount: { amountMinor: "0", currencyCode: "CAD" },
            tax: { amountMinor: "117", currencyCode: "CAD" },
            fee: { amountMinor: "0", currencyCode: "CAD" },
            total: { amountMinor: "1017", currencyCode: "CAD" },
            tip: { amountMinor: "116", currencyCode: "CAD" },
          },
        },
      },
    }),
  );
  const payments: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    payments.push(body);
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(60),
        orderBatchReference: id(61),
        amountMinor: "1133",
        recordingReason: "AtCounter",
        takenAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        cash: {
          cashTotalMinor: "1135",
          roundingMinor: "2",
          tenderedMinor: "2000",
          changeMinor: "865",
        },
        acceptance: "Accepted",
      },
    });
  });
  await page.goto("/operations/order-entry");
  const awaiting = page.getByRole("region", { name: "Sent, not paid yet" });
  await expect(awaiting).toContainText(/Take payment by \d\d:\d\d · released if unpaid/u);
  await awaiting.getByRole("button", { name: "Take payment" }).click();
  const form = awaiting.getByRole("form", { name: "Record card-machine payment" });
  await form.getByRole("radio", { name: "Cash" }).check();
  await expect(form).toContainText("Take $11.35 in cash (rounded to 5 cents)");
  await form.getByRole("button", { name: "$20.00", exact: true }).click();
  await expect(form).toContainText("Change $8.65");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-cash-awaiting-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await form.getByRole("button", { name: "Cash received · $11.35" }).click();
  const paidPanel = page.getByRole("region", { name: "Order 21 paid" });
  await expect(paidPanel).toContainText("Paid in cash$11.35");
  await expect(paidPanel).toContainText("Change to give$8.65");
  await expect(paidPanel.getByRole("status")).toHaveText(
    "Cash recorded. Give $8.65 change. Sent to the kitchen.",
  );
  expect(payments).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      orderReference: id(60),
      orderBatchReference: id(61),
      expectedTotalMinor: "1133",
      slipReference: null,
      takenAt: null,
      tenderedMinor: "2000",
    },
  ]);
});

// WP-2423 M52: a Record with no answer keeps the cash received as sent, so recording again is the
// same payment and shows the change really recorded; a large change is checked before recording.
test("@production a cash record with no answer is sent again unchanged, and a large change is checked first", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  await page.route("**/merchant/counter/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(40),
        orderBatchReference: id(41),
        orderNumber: "16",
        orderVersion: 1,
        orderMinor: "424",
        tipMinor: "0",
        totalMinor: "424",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    }),
  );
  const payments: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    payments.push(body);
    // The first Record reached the server, but its answer was lost on the way back.
    if (payments.length === 1) return route.abort("failed");
    return route.fulfill({
      headers,
      json: {
        status: "AlreadyRecorded",
        orderReference: id(40),
        orderBatchReference: id(41),
        amountMinor: "424",
        recordingReason: "AtCounter",
        takenAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        cash: {
          cashTotalMinor: "425",
          roundingMinor: "1",
          tenderedMinor: String(payments[0]?.tenderedMinor),
          changeMinor: String(Number(payments[0]?.tenderedMinor) - 425),
        },
        acceptance: "Accepted",
      },
    });
  });

  await page.goto("/operations/order-entry");
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await page
    .getByRole("group", { name: "How the guest pays" })
    .getByRole("radio", { name: "Cash" })
    .check();
  const received = page.getByRole("textbox", { name: "Cash received" });
  const record = page.getByRole("button", { name: "Cash received · $4.25" });
  // "5000" typed for $50.00: $4,995.75 in change is checked before it can be recorded.
  await received.fill("5000");
  await expect(
    page.getByText("That is $4,995.75 in change. Check the cash received before you record it."),
  ).toBeVisible();
  await expect(record).toBeDisabled();
  await received.fill("50");
  await expect(page.getByText("Change $45.75")).toBeVisible();
  await expect(page.getByText(/in change\. Check the cash received/u)).toHaveCount(0);
  // A $100 bill is still a usual amount: $95.75 change records without the check.
  await received.fill("100");
  await expect(record).toBeEnabled();
  // A real $200 for a $4.25 order: the cashier confirms it, then records.
  await received.fill("200");
  await expect(record).toBeDisabled();
  await page.getByRole("checkbox", { name: "I counted $200.00 received" }).check();
  await expect(record).toBeEnabled();
  await record.click();
  // The cash received stays as sent until the payment is answered.
  await expect(received).toBeDisabled();
  await expect(received).toHaveValue("200");
  await expect(
    page.getByText(
      "No answer from the system. Record again: it sends the same $200.00 received, so it is never counted twice.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: "Card machine" })).toBeDisabled();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-cash-unanswered-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await record.click();
  // The same payment, and the change that was really recorded.
  expect(payments).toHaveLength(2);
  expect(payments[1]).toEqual(payments[0]);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Cash recorded. Give $195.75 change. Sent to the kitchen." }),
  ).toBeVisible();
});

// v15 batch 8 (counter cash wording): a paid cash counter order's Cancel order dialog says the cash
// goes back from the drawer in whole nickels, never the card machine; and Orders with an order open
// beside a list of partly refunded cash orders fits a tablet without sideways scrolling.
test("@production cancelling a cash counter order says cash back from the drawer, and the open list fits a tablet", async ({
  page,
}) => {
  await signIn(page);
  const cashOrder = (n: number, refundedMinor: string, canCancel: boolean) => ({
    orderReference: id(300 - n * 2),
    orderNumber: String(30 + n),
    orderType: "Pickup",
    sourceChannel: "Pos",
    submittedAt: "2026-10-13T16:00:00.000Z",
    observedAt: "2026-10-13T16:20:00.000Z",
    initialBatchReference: id(301 - n * 2),
    summary: {
      items: [
        { name: "Smashed cucumber with garlic and chili oil", option: null, quantity: 1 },
        { name: "Soy milk", option: "Hot", quantity: 1 },
      ],
      lineCount: 2,
      pickupName: null,
      tableLabel: null,
    },
    counter: {
      recordedAfterOutage: false,
      paidOnCardMachine: {
        amountMinor: "1074",
        takenAt: "2026-10-13T16:01:00.000Z",
        recordedAfterOutage: false,
        refundedMinor,
        cash: { tenderedMinor: "2000", changeMinor: "925", roundingMinor: "1" },
      },
    },
    batches: [
      {
        orderBatchReference: id(301 - n * 2),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel,
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
  });
  // Tables paid by phone and partly refunded, as on the live list beside the cash orders.
  const tableOrder = (n: number) => ({
    orderReference: id(280 - n * 2),
    orderNumber: String(20 + n),
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-10-13T15:00:00.000Z",
    observedAt: "2026-10-13T16:20:00.000Z",
    initialBatchReference: id(281 - n * 2),
    summary: {
      items: [
        { name: "Beef noodles (TEST)", option: null, quantity: 1 },
        { name: "Beef noodles (TEST)", option: "Large", quantity: 1 },
      ],
      lineCount: 2,
      pickupName: null,
      tableLabel: "MRS " + String(n + 1) + " (TEST)",
    },
    batches: [
      {
        orderBatchReference: id(281 - n * 2),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: false,
    tableBill: {
      totalMinor: "1212",
      paid: { amountMinor: "1212", method: n % 2 === 0 ? "Online" : "Split", refundedMinor: "500" },
    },
    currentPhase: "Served",
    currentVersion: 4,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  const listed = {
    items: [
      cashOrder(0, "0", true),
      ...Array.from({ length: 7 }, (_, n) => cashOrder(n + 1, n % 2 === 0 ? "500" : "365", false)),
      ...Array.from({ length: 4 }, (_, n) => tableOrder(n)),
    ],
    nextAfterOrderReference: null,
  };
  await page.route("**/merchant/orders?*", (route) => route.fulfill({ headers, json: listed }));
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: listed }));
  await page.route("**/merchant/orders/cancel/preview", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(300),
        orderBatchReference: id(301),
        refundMethod: "CardMachine",
        paidInCash: true,
        paidMinor: "1075",
        refundMinor: "1075",
        currencyCode: "CAD",
      },
    }),
  );
  // Opened on a wide screen, then the window narrows to a tablet with the order still open.
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "30", exact: true }).click();
  await expect(orderPanel(page)).toContainText("Paid in cash");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(orderPanel(page)).toContainText("Paid in cash");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/counter-cash-open-${width}.png`, fullPage: true });
  }
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/operations/orders");
    await page.getByRole("button", { name: "30", exact: true }).click();
    const entry = orderPanel(page);
    await entry.getByRole("button", { name: "Cancel order" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(
      "Give back $10.75 in cash from the drawer, tip included, in whole nickels.",
    );
    await expect(dialog).not.toContainText("card machine");
    await page.keyboard.press("Escape");
  }
});

// v15 batch 8: the payment and refund pages of a counter cash payment speak of cash from the
// drawer in whole nickels from the summary to the recorded refund, never of the card machine.
test("@production refunding a dish of a cash counter order speaks of cash from the drawer throughout", async ({
  page,
}) => {
  await signIn(page);
  const intent = id(331),
    attempt = id(332);
  let requested: Record<string, unknown> | null = null;
  let given = false;
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
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({
      headers,
      json: {
        paymentIntentReference: intent,
        paymentAttemptReference: attempt,
        orderReference: id(320),
        orderBatchReference: id(321),
        observedAt: new Date().toISOString(),
        paymentState: "Captured",
        paymentMethod: "CardMachine",
        paidInCash: true,
        // $10.75 taken in cash, nothing given back yet.
        cashLeftMinor: given ? "710" : "1075",
        currencyCode: "CAD",
        capturedAmountMinor: "1074",
        confirmedRefundMinor: given ? "367" : "0",
        pendingRefundMinor: requested !== null && !given ? "367" : "0",
        canRequest: true,
        requestBlocked: null,
        canSend: true,
      },
    }),
  );
  const request = () => ({
    requestReference: String(requested?.requestReference),
    operationReference: String(requested?.operationReference),
    claimVersion: 1,
    requestedAt: "2026-10-13T16:30:00.000Z",
    reasonCode: "QUALITY_ISSUE",
    currencyCode: "CAD",
    amountMinor: "367",
    decline: null,
    progress: given ? "Refunded" : "Recorded",
    paymentMethod: "CardMachine",
  });
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(320),
        orderNumber: "35",
        canRequest: true,
        claimVersion: requested === null ? 0 : 1,
        recentRequests: requested === null ? [] : [request()],
        items: [
          {
            orderBatchReference: id(321),
            orderItemReference: id(322),
            label: "Soy milk",
            quantity: 1,
            unclaimedQuantity: requested === null ? 1 : 0,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: intent,
            paymentMethod: "CardMachine",
          },
          {
            orderBatchReference: id(321),
            orderItemReference: id(323),
            label: "Smashed cucumber",
            quantity: 1,
            unclaimedQuantity: 1,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: intent,
            paymentMethod: "CardMachine",
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/preview", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    return route.fulfill({
      headers,
      json: {
        status: "Previewed",
        requestReference: body.requestReference,
        operationReference: body.operationReference,
        claimVersion: 0,
        currencyCode: "CAD",
        amountMinor: "367",
        paymentAttemptReferences: [attempt],
        approvalRequired: false,
        escalationReasons: [],
        approveAlone: false,
        components: {
          netAmountMinor: "325",
          taxAmountMinor: "42",
          tipAmountMinor: "0",
          serviceChargeAmountMinor: "0",
          serviceChargeTaxAmountMinor: "0",
        },
      },
    });
  });
  await page.route("**/merchant/payments/refunds/request", (route) => {
    requested = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    return route.fulfill({
      status: 202,
      headers,
      json: {
        status: "RequestRecorded",
        requestReference: requested.requestReference,
        operationReference: requested.operationReference,
        claimVersion: 1,
        currencyCode: "CAD",
        amountMinor: "367",
        paymentAttemptReferences: [attempt],
        approvalRequired: false,
        escalationReasons: [],
        approveAlone: false,
        replayed: false,
      },
    });
  });
  await page.route("**/merchant/payments/refunds/status", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(320),
        requestReference: requested?.requestReference,
        operationReference: requested?.operationReference,
        observedAt: new Date().toISOString(),
        currencyCode: "CAD",
        amountMinor: "367",
        payments: [
          {
            paymentAttemptReference: attempt,
            paymentIntentReference: intent,
            state: given ? "Confirmed" : "NotDispatched",
            method: "CardMachine",
            refundedOnCardMachineAt: given ? "2026-10-13T16:32:00.000Z" : null,
            cardMachineSlipReference: null,
            executionOperationReference: null,
            executionApprovalReference: null,
            amountMinor: "367",
            confirmedMinor: given ? "367" : "0",
            pendingMinor: given ? "0" : "367",
            // $3.67 goes back as $3.65 from the drawer (whole nickels).
            cashGivenBackMinor: "365",
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/card-machine-record", (route) => {
    given = true;
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(320),
        requestReference: requested?.requestReference,
        // What the drawer gave back, as the server records it (whole nickels).
        amountMinor: "365",
        refundedAt: "2026-10-13T16:32:00.000Z",
        receipt: "NoDigitalReceipt",
      },
    });
  });
  const main = page.getByRole("main");
  await page.goto("/app/operations/payments/" + intent + "/refund");
  const summary = page.getByRole("region", { name: "Payment summary" });
  await expect(summary).toContainText("Paid in cash at the counter.");
  await expect(summary).toContainText("whole nickels");
  await page.getByRole("spinbutton", { name: /Soy milk/ }).fill("1");
  await page.getByRole("combobox", { name: "Reason" }).selectOption("QUALITY_ISSUE");
  await page.getByRole("button", { name: "Review refund" }).click();
  const review = page.getByRole("region", { name: "Review this refund" });
  await expect(review).toContainText(
    "Paid in cash. After the request is recorded, give back $3.65 from the drawer (the refund of $3.67, in whole nickels) and record it under the request.",
  );
  await expect(main).not.toContainText("card machine");
  await page.getByRole("checkbox", { name: /I confirm/ }).check();
  await page.getByRole("button", { name: "Record refund request" }).click();
  await expect(
    page.getByText(
      "Request recorded for $3.67. Now give back $3.65 from the drawer (in whole nickels) and record it under the request above.",
    ),
  ).toBeVisible();
  const requests = page.getByRole("region", { name: "Refunds on this order" });
  await expect(requests).toContainText("To give back in cash");
  await expect(requests).toContainText("Hand back $3.65 from the drawer");
  await expect(main).not.toContainText("card machine");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-cash-refund-request-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // The payment page itself, with the cash still to give back: its heading and record action stay
  // in cash words before and after recording.
  given = false;
  await page.goto("/app/operations/payments/" + intent);
  const pending = page.getByRole("region", { name: "Cash to give back" });
  await expect(pending).toContainText("To give back in cash");
  await pending.getByRole("button", { name: "Record $3.65 given back in cash" }).click();
  await pending.getByRole("button", { name: "Gave back $3.65 in cash" }).click();
  await expect(pending).toContainText("Cash given back recorded: $3.65");
  await expect(page.getByRole("heading", { name: "Cash to give back" })).toBeVisible();
  await expect(main).not.toContainText("card machine");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-cash-payment-${width}.png`,
      fullPage: true,
    });
  }
});

// v15 batch 8 (review): the usual case in a restaurant — a cashier asks for a cash refund and a
// manager or the owner gives it back. Neither the cashier's page nor Approvals ever says the card
// machine, a slip, or "send": they name the cash the drawer gives back, in whole nickels.
test("@production a cashier's cash refund names a manager giving it back from the drawer", async ({
  page,
}) => {
  await signIn(page);
  const intent = id(341),
    attempt = id(342);
  let requested: Record<string, unknown> | null = null;
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
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({
      headers,
      json: {
        paymentIntentReference: intent,
        paymentAttemptReference: attempt,
        orderReference: id(340),
        orderBatchReference: id(343),
        observedAt: new Date().toISOString(),
        paymentState: "Captured",
        paymentMethod: "CardMachine",
        paidInCash: true,
        cashLeftMinor: "1075",
        currencyCode: "CAD",
        capturedAmountMinor: "1074",
        confirmedRefundMinor: "0",
        pendingRefundMinor: requested === null ? "0" : "367",
        canRequest: true,
        requestBlocked: null,
        // A cashier asks; a manager or the owner gives it back.
        canSend: false,
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(340),
        orderNumber: "36",
        canRequest: true,
        claimVersion: requested === null ? 0 : 1,
        recentRequests:
          requested === null
            ? []
            : [
                {
                  requestReference: String(requested.requestReference),
                  operationReference: String(requested.operationReference),
                  claimVersion: 1,
                  requestedAt: "2026-10-13T16:30:00.000Z",
                  reasonCode: "QUALITY_ISSUE",
                  currencyCode: "CAD",
                  amountMinor: "367",
                  decline: null,
                  progress: "Recorded",
                  paymentMethod: "CardMachine",
                },
              ],
        items: [
          {
            orderBatchReference: id(343),
            orderItemReference: id(344),
            label: "Soy milk",
            quantity: 1,
            unclaimedQuantity: requested === null ? 1 : 0,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: intent,
            paymentMethod: "CardMachine",
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/preview", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    return route.fulfill({
      headers,
      json: {
        status: "Previewed",
        requestReference: body.requestReference,
        operationReference: body.operationReference,
        claimVersion: 0,
        currencyCode: "CAD",
        amountMinor: "367",
        paymentAttemptReferences: [attempt],
        approvalRequired: false,
        escalationReasons: [],
        approveAlone: false,
        components: {
          netAmountMinor: "325",
          taxAmountMinor: "42",
          tipAmountMinor: "0",
          serviceChargeAmountMinor: "0",
          serviceChargeTaxAmountMinor: "0",
        },
      },
    });
  });
  await page.route("**/merchant/payments/refunds/request", (route) => {
    requested = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    return route.fulfill({
      status: 202,
      headers,
      json: {
        status: "RequestRecorded",
        requestReference: requested.requestReference,
        operationReference: requested.operationReference,
        claimVersion: 1,
        currencyCode: "CAD",
        amountMinor: "367",
        paymentAttemptReferences: [attempt],
        approvalRequired: false,
        escalationReasons: [],
        approveAlone: false,
        replayed: false,
      },
    });
  });
  await page.route("**/merchant/payments/refunds/status", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(340),
        requestReference: requested?.requestReference,
        operationReference: requested?.operationReference,
        observedAt: new Date().toISOString(),
        currencyCode: "CAD",
        amountMinor: "367",
        payments: [
          {
            paymentAttemptReference: attempt,
            paymentIntentReference: intent,
            state: "NotDispatched",
            method: "CardMachine",
            refundedOnCardMachineAt: null,
            cardMachineSlipReference: null,
            executionOperationReference: null,
            executionApprovalReference: null,
            amountMinor: "367",
            confirmedMinor: "0",
            pendingMinor: "367",
            cashGivenBackMinor: "365",
          },
        ],
      },
    }),
  );
  const main = page.getByRole("main");
  await page.goto("/app/operations/payments/" + intent + "/refund");
  await page.getByRole("spinbutton", { name: /Soy milk/ }).fill("1");
  await page.getByRole("combobox", { name: "Reason" }).selectOption("QUALITY_ISSUE");
  await page.getByRole("button", { name: "Review refund" }).click();
  await expect(page.getByRole("region", { name: "Review this refund" })).toContainText(
    "Paid in cash. Recording this request gives nothing back yet: a manager or the owner gives back $3.65 from the drawer (the refund of $3.67, in whole nickels) and records it on the payment page.",
  );
  await page.getByRole("checkbox", { name: /I confirm/ }).check();
  await page.getByRole("button", { name: "Record refund request" }).click();
  await expect(
    page.getByText(
      "Request recorded for $3.67. Nothing is given back yet: a manager or the owner gives back $3.65 from the drawer (in whole nickels) and records it on the payment page.",
    ),
  ).toBeVisible();
  await expect(main).not.toContainText("card machine");
  await expect(main).not.toContainText("sends it");
  // b10 cash-refund-approvals: the request below says who gives the cash back, and the cashier is
  // offered no way to record it themselves (the server refuses them too, as since b9).
  await expect(main).toContainText(
    "Not given back yet. A manager or the owner gives back $3.65 in cash and records it.",
  );
  await expect(main.getByRole("button", { name: /Gave back/u })).toHaveCount(0);
  await expect(main).not.toContainText("then record it here");
});

// b12: a cashier opened the payment page of cash order 18 after asking for a $5.09 refund. It was
// listed twice, under Cash to give back (headed $5.09, "gives back $5.10") and again under the
// order's refund requests, each with its own Refresh. It is listed once, at the cash that goes back.
test("@production a cashier's cash refund is listed once on the payment page, at the cash that goes back", async ({
  page,
}) => {
  await signIn(page);
  const intent = id(361),
    attempt = id(362);
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
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({
      headers,
      json: {
        paymentIntentReference: intent,
        paymentAttemptReference: attempt,
        orderReference: id(360),
        orderBatchReference: id(363),
        observedAt: new Date().toISOString(),
        paymentState: "Captured",
        paymentMethod: "CardMachine",
        paidInCash: true,
        cashLeftMinor: "510",
        currencyCode: "CAD",
        capturedAmountMinor: "509",
        confirmedRefundMinor: "0",
        pendingRefundMinor: "509",
        canRequest: true,
        requestBlocked: null,
        canSend: false,
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(360),
        orderNumber: "18",
        canRequest: true,
        claimVersion: 1,
        recentRequests: [
          {
            requestReference: id(364),
            operationReference: id(365),
            claimVersion: 1,
            requestedAt: "2026-11-12T16:30:00.000Z",
            reasonCode: "QUALITY_ISSUE",
            currencyCode: "CAD",
            amountMinor: "509",
            decline: null,
            progress: "Recorded",
            paymentMethod: "CardMachine",
          },
        ],
        items: [
          {
            orderBatchReference: id(363),
            orderItemReference: id(366),
            label: "Lemon tea (TEST)",
            quantity: 1,
            unclaimedQuantity: 0,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: intent,
            paymentMethod: "CardMachine",
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/status", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(360),
        requestReference: id(364),
        operationReference: id(365),
        observedAt: new Date().toISOString(),
        currencyCode: "CAD",
        amountMinor: "509",
        payments: [
          {
            paymentAttemptReference: attempt,
            paymentIntentReference: intent,
            state: "NotDispatched",
            method: "CardMachine",
            refundedOnCardMachineAt: null,
            cardMachineSlipReference: null,
            executionOperationReference: null,
            executionApprovalReference: null,
            amountMinor: "509",
            confirmedMinor: "0",
            pendingMinor: "509",
            cashGivenBackMinor: "510",
          },
        ],
      },
    }),
  );
  const main = page.getByRole("main");
  await page.goto("/app/operations/payments/" + intent);
  const cash = page.getByRole("region", { name: "Cash to give back" });
  await expect(cash).toContainText(
    "Not given back yet. A manager or the owner gives back $5.10 in cash and records it.",
  );
  await expect(cash.locator(".refund-request__amount")).toHaveText("$5.10");
  await expect(main.getByText(/Request 1 ·/u)).toHaveCount(1);
  // b13: the refund itself is named beside the cash that goes back.
  await expect(cash).toContainText("Refund of $5.09, in cash rounded to 5 cents");
  await expect(main.locator(".refund-request__amount")).toHaveCount(1);
  await expect(main.getByRole("button", { name: /^Refresh/u })).toHaveCount(1);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("cashier-cash-refund-once-" + width + ".png"),
      fullPage: true,
    });
  }
});

// b13 (v15 b12 live, DEMO order 3): the Refund page still read "$5.09 To give back in cash" with
// "gives back $5.10" and three Refresh links; once given back, "$5.09 Given back in cash" and
// "Refunded $5.09" though $5.10 left the drawer. Both amounts are said together, with one Refresh.
for (const done of [false, true])
  test(`@production the refund page says a cash refund's refund and cash together, with one Refresh (${done ? "given back" : "to give back"})`, async ({
    page,
  }) => {
    await signIn(page);
    const intent = id(371),
      attempt = id(372);
    let contexts = 0;
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
    await page.route("**/merchant/payments/refunds/context", (route) => {
      contexts += 1;
      return route.fulfill({
        headers,
        json: {
          paymentIntentReference: intent,
          paymentAttemptReference: attempt,
          orderReference: id(370),
          orderBatchReference: id(373),
          observedAt: new Date().toISOString(),
          paymentState: "Captured",
          paymentMethod: "CardMachine",
          paidInCash: true,
          cashLeftMinor: done ? "0" : "510",
          cashGivenBackMinor: done ? "510" : "0",
          currencyCode: "CAD",
          capturedAmountMinor: "509",
          confirmedRefundMinor: done ? "509" : "0",
          pendingRefundMinor: done ? "0" : "509",
          canRequest: true,
          requestBlocked: null,
          canSend: false,
        },
      });
    });
    let items = 0;
    await page.route("**/merchant/payments/refunds/items", (route) => {
      items += 1;
      return route.fulfill({
        headers,
        json: {
          orderReference: id(370),
          orderNumber: "3",
          canRequest: true,
          claimVersion: 1,
          recentRequests: [
            {
              requestReference: id(374),
              operationReference: id(375),
              claimVersion: 1,
              requestedAt: "2026-11-13T11:30:00.000Z",
              reasonCode: "QUALITY_ISSUE",
              currencyCode: "CAD",
              amountMinor: "509",
              decline: null,
              progress: done ? "Refunded" : "Recorded",
              paymentMethod: "CardMachine",
              cashGivenBackMinor: "510",
            },
          ],
          items: [
            {
              orderBatchReference: id(373),
              orderItemReference: id(376),
              label: "Lemon tea (TEST)",
              quantity: 1,
              unclaimedQuantity: 0,
              paymentCaptured: true,
              refundedByCancellation: false,
              paymentIntentReference: intent,
              paymentMethod: "CardMachine",
            },
          ],
        },
      });
    });
    await page.route("**/merchant/payments/refunds/status", (route) =>
      route.fulfill({
        headers,
        json: {
          orderReference: id(370),
          requestReference: id(374),
          operationReference: id(375),
          observedAt: new Date().toISOString(),
          currencyCode: "CAD",
          amountMinor: "509",
          payments: [
            {
              paymentAttemptReference: attempt,
              paymentIntentReference: intent,
              state: done ? "Confirmed" : "NotDispatched",
              method: "CardMachine",
              refundedOnCardMachineAt: done ? "2026-11-13T11:40:00.000Z" : null,
              cardMachineSlipReference: null,
              executionOperationReference: null,
              executionApprovalReference: null,
              amountMinor: "509",
              confirmedMinor: done ? "509" : "0",
              pendingMinor: done ? "0" : "509",
              cashGivenBackMinor: "510",
            },
          ],
        },
      }),
    );
    const main = page.getByRole("main");
    await page.goto("/app/operations/payments/" + intent + "/refund");
    const request = main.locator(".refund-request").first();
    await expect(request.locator(".refund-request__amount")).toHaveText("$5.10");
    await expect(request).toContainText(done ? "Given back in cash" : "To give back in cash");
    await expect(request).toContainText("Refund of $5.09, in cash rounded to 5 cents");
    await expect(main.getByText("$5.09 To give back in cash")).toHaveCount(0);
    // One Refresh for the page: it reads the amounts and the requests again.
    const refresh = main.getByRole("button", { name: /Refresh/u });
    await expect(refresh).toHaveCount(1);
    await expect(
      main.getByRole("button", { name: "Refresh the payment and its refunds" }),
    ).toBeVisible();
    if (done) {
      await expect(main.locator(".refund-summary")).toContainText("Refunded$5.09");
      await expect(main.locator(".refund-summary")).toContainText(
        "Cash given back from the drawer$5.10",
      );
    } else
      await expect(main).toContainText(
        "Not given back yet. A manager or the owner gives back $5.10 in cash and records it.",
      );
    const before = { contexts, items };
    await refresh.click();
    await expect.poll(() => contexts).toBeGreaterThan(before.contexts);
    await expect.poll(() => items).toBeGreaterThan(before.items);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`b13-refund-page-cash-${done ? "done" : "pending"}-${width}.png`),
        fullPage: true,
      });
    }
  });

test("@production on Approvals a cash refund is approved and given back from the drawer, never on the machine", async ({
  page,
}) => {
  const entry = {
    orderReference: id(350),
    orderNumber: "35",
    requestReference: id(351),
    requestOperationReference: id(352),
    paymentAttemptReferences: [id(353)],
    paymentIntentReferences: [id(354)],
    // b12: a counter cash payment reads Cash, never CardMachine.
    paymentMethod: "Cash",
    // $3.67 asked; the drawer gives back $3.65 (whole nickels, as the server counts it).
    cashGivenBackMinor: "365",
    currencyCode: "CAD",
    amountMinor: "367",
    reasonCode: "QUALITY_ISSUE",
    note: null,
    escalationReasons: ["MoreThan24Hours"],
    requestedAt: new Date(Date.now() - 60_000).toISOString(),
    requesterName: "Mia",
    requestedByYou: false,
    requesterVerifiedUntil: new Date(Date.now() + 14 * 60_000).toISOString(),
    state: "AwaitingApproval",
    approvalReference: null,
    approvedAt: null,
    approverName: null,
    canApprove: true,
    soleOperatorApproval: false,
  };
  const notSent = {
    ...entry,
    orderNumber: "36",
    requestReference: id(355),
    requestOperationReference: id(356),
    escalationReasons: [],
    requesterName: "Sam",
    state: "NotSent",
    canApprove: false,
  };
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
          businessDate: "2026-10-13",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
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
  await page.route("**/merchant/organization/sole-operator", (route) =>
    route.fulfill({ headers, json: { brandOwner: false } }),
  );
  await page.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ headers, json: { validUntil: null } });
    const at = Date.now();
    return route.fulfill({
      headers,
      json: {
        status: "Verified",
        verifiedAt: new Date(at).toISOString(),
        validUntil: new Date(at + 15 * 60_000).toISOString(),
      },
    });
  });
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: true,
        canSend: true,
        soleOperator: null,
        entries: [entry, notSent],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/approve", (route) =>
    route.fulfill({
      status: 202,
      headers,
      json: {
        status: "Approved",
        approvalReference: JSON.parse(route.request().postData() ?? "{}").approvalReference,
        replayed: false,
        payments: [
          {
            paymentAttemptReference: id(353),
            operationReference: id(357),
            state: "RecordOnCardMachine",
          },
        ],
      },
    }),
  );
  await page.goto("/app/approvals");
  const main = page.getByRole("main");
  const waiting = page.getByRole("listitem").filter({ hasText: "Order 36" });
  await expect(waiting).toContainText("Asked by Sam, waiting for you to give it back in cash");
  await expect(waiting).toContainText(
    "Paid in cash: give back $3.65 from the drawer (the refund of $3.67, in whole nickels), then record it on the payment page.",
  );
  const card = page.getByRole("listitem").filter({ hasText: "Order 35" });
  await expect(card).toContainText("Cash at the counter");
  await card.getByRole("button", { name: "Approve giving back $3.65 in cash" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(card).toContainText("Approved — give back $3.65 in cash, then record it");
  await expect(card.getByRole("status")).toContainText(
    "Approved. Give back $3.65 in cash from the drawer (the refund of $3.67, in whole nickels), then record it on the payment page.",
  );
  await expect(card.getByRole("link", { name: "Record the cash given back" })).toHaveAttribute(
    "href",
    "/app/operations/payments/" + id(354),
  );
  await expect(main).not.toContainText("card machine");
  await expect(main).not.toContainText("slip");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-cash-approvals-${width}.png`,
      fullPage: true,
    });
  }
});

// b10 cash-refund-approvals: after $3.65 was given back from the drawer for a $3.67 refund, Money
// taken back on the payment page offers cash alone, up to $3.65, and records it in cash.
test("@production money taken back on a cash order is cash from the guest, up to the cash given back", async ({
  page,
}) => {
  await signIn(page);
  const intent = id(361),
    attempt = id(362);
  let recovered: Record<string, unknown> | null = null;
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
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({
      headers,
      json: {
        paymentIntentReference: intent,
        paymentAttemptReference: attempt,
        orderReference: id(360),
        orderBatchReference: id(363),
        observedAt: new Date().toISOString(),
        paymentState: "Captured",
        paymentMethod: "CardMachine",
        paidInCash: true,
        cashLeftMinor: "710",
        currencyCode: "CAD",
        capturedAmountMinor: "1074",
        confirmedRefundMinor: "367",
        pendingRefundMinor: "0",
        canRequest: true,
        requestBlocked: null,
        canSend: true,
        canRecover: true,
        recoveries:
          recovered === null
            ? []
            : [
                {
                  recoveryReference: id(364),
                  method: "Cash",
                  amountMinor: String(recovered.amountMinor),
                  currencyCode: "CAD",
                  reasonCode: "REFUNDED_TOO_MUCH",
                  businessDate: "2026-11-11",
                  recordedAt: new Date().toISOString(),
                  recordedByName: "Mia",
                },
              ],
        cashTakeBackLeftMinor: recovered === null ? "365" : "0",
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(360),
        orderNumber: "96",
        canRequest: true,
        claimVersion: 1,
        recentRequests: [],
        items: [],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/recover", (route) => {
    recovered = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(360),
        recovery: {
          recoveryReference: id(364),
          method: "Cash",
          amountMinor: String(recovered.amountMinor),
          currencyCode: "CAD",
          reasonCode: "REFUNDED_TOO_MUCH",
          businessDate: "2026-11-11",
          recordedAt: new Date().toISOString(),
          recordedByName: "Mia",
        },
      },
    });
  });
  await page.goto("/app/operations/payments/" + intent);
  const section = page.getByRole("region", { name: "Money taken back" });
  await section.getByRole("button", { name: "Take money back" }).click();
  await expect(section).toContainText("Paid in cash: the guest hands back cash, in whole nickels.");
  await expect(section.getByRole("radio")).toHaveCount(0);
  await expect(section).not.toContainText("card machine");
  const amount = section.getByLabel("Cash handed back (up to $3.65)");
  await amount.fill("3.67");
  await section.getByRole("button", { name: "Record money taken back" }).click();
  await expect(section.getByRole("status")).toHaveText(
    "Cash comes back in whole nickels, for example 3.65.",
  );
  await amount.fill("3.65");
  await section.getByRole("checkbox").check();
  await section.getByRole("button", { name: "Record money taken back" }).click();
  await expect(section).toContainText("Money taken back +$3.65 · Cash · Mia");
  expect(recovered).toMatchObject({ method: "Cash", amountMinor: "365" });
  expect(recovered).not.toHaveProperty("slipReference");
  await expect(section.getByRole("button", { name: "Take money back" })).toHaveCount(0);
});
