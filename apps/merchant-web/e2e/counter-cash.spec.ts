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
