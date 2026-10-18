import { expect, test, type Page } from "@playwright/test";

// WP-2423 Q7 (OPS-ORDER-ENTRY, DEC-COUNTER-PAYMENT-RECORD): staff take a pickup order at the
// counter, charge it on the store's card machine and record it; a paper order is entered after an
// outage; the order queue shows counter orders and a card-machine refund is recorded.
const id = (n: number) => "01909977-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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

test("@production staff take a counter pickup order, charge it on the card machine and record it", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  const placedBodies: Record<string, unknown>[] = [];
  let soldOutOnce = true;
  await page.route("**/merchant/counter/orders", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    placedBodies.push(body);
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    if (soldOutOnce && (body.lines as unknown[]).length === 2) {
      soldOutOnce = false;
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "item_unavailable", lineIndex: 1 },
      });
    }
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "12",
        orderVersion: 1,
        orderMinor: "593",
        tipMinor: "79",
        totalMinor: "672",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: body.recordedAfterOutage === true,
      },
    });
  });
  const payments: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    payments.push(body);
    if (body.expectedTotalMinor !== "672")
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "amount_changed", totalMinor: "672" },
      });
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(20),
        orderBatchReference: id(21),
        amountMinor: "672",
        recordingReason: body.takenAt === null ? "AtCounter" : "RecordedAfterOutage",
        takenAt: (body.takenAt as string | null) ?? new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        // WP-2423 D1: the server accepts the paid order with its payment record.
        acceptance: "Accepted",
      },
    });
  });
  const accepted: unknown[] = [];
  await page.route("**/merchant/orders/accept", (route) => {
    accepted.push(route.request().postDataJSON());
    return route.fulfill({
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "Created", acceptedOrderVersion: 2 }),
    });
  });

  await page.goto("/operations/order-entry");
  await expect(page.getByRole("heading", { level: 1, name: "Counter order" })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Counter order" }),
  ).toHaveAttribute("aria-current", "page");
  // Sold out items cannot be added.
  await expect(page.getByRole("button", { name: "Add Butter Croissant" })).toBeDisabled();
  await page.getByRole("button", { name: "Add Flat White" }).click();
  await page.getByRole("radio", { name: /Oat milk/ }).check();
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await page.getByRole("button", { name: "Add to order" }).click();
  const ticket = page.getByRole("list", { name: "Items in this order" });
  await expect(ticket).toContainText("1 × Flat White · Oat milk");
  await expect(ticket).toContainText("$5.25");
  await expect(page.getByText("About $9.00 before tax and tip.")).toBeVisible();
  await page.getByRole("radio", { name: "15%" }).check();

  // Banana Bread sold out while staff were taking the order: plain words, nothing charged.
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Banana Bread can't be sold right now (sold out or off the menu).",
  );
  await page.getByRole("button", { name: "Remove Banana Bread" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $6.72 on the card machine" }),
  ).toBeVisible();
  // The browser sends intent only: items, options, tip choice — never prices or totals.
  expect(placedBodies.at(-1)).toEqual({
    operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    lines: [
      {
        sellableReference: id(5),
        quantity: 1,
        optionSelections: [{ optionReference: id(10), quantity: 1 }],
      },
    ],
    tip: { kind: "Percent", percent: 15 },
    recordedAfterOutage: false,
  });
  await expect(page.getByText(/Record the payment by \d\d:\d\d/u)).toBeVisible();
  const slip = page.getByRole("textbox", { name: "Slip reference (optional)" });
  await slip.fill("1234 5678 9012 3456");
  await expect(page.getByRole("button", { name: /Paid on card machine/ })).toBeDisabled();
  await slip.fill("AUTH 482913");

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(
      page.getByRole("heading", { name: "Charge $6.72 on the card machine" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/counter-order-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "Paid on card machine · $6.72" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Paid and sent to the kitchen." }),
  ).toBeVisible();
  expect(payments).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      orderReference: id(20),
      orderBatchReference: id(21),
      expectedTotalMinor: "672",
      slipReference: "AUTH 482913",
      takenAt: null,
    },
  ]);
  // WP-2423 D1: accepted by the server with the payment, not by the page.
  expect(accepted).toHaveLength(0);
  await expect(page.locator("body")).not.toContainText(id(20));

  // A paper order taken during an outage: entered with the time it was paid, not sent again.
  await page.getByRole("button", { name: "New counter order" }).click();
  await page.getByRole("button", { name: "Add Flat White" }).click();
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("checkbox", { name: "Recorded after an outage (taken on paper)" }).check();
  await expect(page.getByRole("button", { name: "Send order" })).toBeDisabled();
  const paid = new Date(Date.now() - 2 * 60 * 60_000);
  const local = (value: Date) =>
    new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.getByLabel("Paid at (store time, from the paper order)").fill(local(paid));
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $6.72 on the card machine" }),
  ).toBeVisible();
  expect(placedBodies.at(-1)?.recordedAfterOutage).toBe(true);
  await page.getByRole("button", { name: "Paid on card machine · $6.72" }).click();
  await expect(
    page.getByText("Recorded after the outage and accepted.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(payments.at(-1)?.takenAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u));
  expect(accepted).toHaveLength(0);
});

test("@production the order queue shows counter orders and records a card-machine refund", async ({
  page,
}) => {
  await signIn(page);
  let refunded = false;
  const counterRow = () => ({
    orderReference: id(30),
    orderNumber: "12",
    orderType: "Pickup",
    sourceChannel: "Pos",
    submittedAt: "2026-10-13T16:00:00.000Z",
    observedAt: "2026-10-13T16:20:00.000Z",
    initialBatchReference: id(31),
    counter: {
      recordedAfterOutage: true,
      paidOnCardMachine: {
        amountMinor: "672",
        takenAt: "2026-10-13T15:40:00.000Z",
        recordedAfterOutage: true,
        refundedMinor: refunded ? "672" : "0",
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
          refundAmountMinor: "672",
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
  // A paid counter order that expired before it was accepted: refunded on the machine by staff.
  const expiredRow = () => ({
    orderReference: id(40),
    orderNumber: "14",
    orderType: "Pickup",
    sourceChannel: "Pos",
    submittedAt: "2026-10-13T16:30:00.000Z",
    observedAt: "2026-10-13T17:20:00.000Z",
    initialBatchReference: id(41),
    counter: {
      recordedAfterOutage: false,
      paidOnCardMachine: {
        amountMinor: "500",
        takenAt: "2026-10-13T16:31:00.000Z",
        recordedAfterOutage: false,
        refundedMinor: "0",
      },
    },
    batches: [
      {
        orderBatchReference: id(41),
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
    unfulfillable: "CapacityExpired",
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  const listed = () => ({ items: [expiredRow(), counterRow()], nextAfterOrderReference: null });
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
        amountMinor: "672",
        refundedAt: new Date().toISOString(),
      },
    });
  });
  await page.goto("/operations/orders");
  const expired = page.locator("details.order-workbench-entry").first();
  await expect(expired).toContainText("Expired · refund on card machine");
  await expect(
    expired.getByText("refund $5.00 on the card machine, then record it here.", { exact: false }),
  ).toBeAttached();
  await expired.locator("summary").click();
  await expect(expired.getByRole("button", { name: "Record card-machine refund" })).toBeVisible();
  await expired.locator("summary").click();
  const entry = page.locator("details.order-workbench-entry").nth(1);
  await entry.locator("summary").click();
  await expect(entry).toContainText("Pickup · Counter");
  await expect(entry).toContainText("Paid on card machine $6.72");
  await expect(entry).toContainText("Recorded after outage");
  await expect(entry).toContainText("Cancelled by store · refund on card machine");
  await expect(
    entry.getByText("Refund $6.72 on the store's card machine, then record it here."),
  ).toBeVisible();
  await expect(entry.getByText(/Taken at the counter\./u)).toBeVisible();
  await entry.getByRole("button", { name: "Record card-machine refund" }).click();
  const dialog = page.getByRole("dialog", { name: "Refund $6.72 on the card machine" });
  await dialog.getByRole("textbox", { name: "Slip reference (optional)" }).fill("REFUND 7731");
  await dialog.getByRole("button", { name: "Refunded $6.72 on card machine" }).click();
  await expect(entry).toContainText("Cancelled by store · refunded on card machine");
  // WP-2423: recording the refund refreshes the order in place; it stays open.
  await expect(entry).toHaveAttribute("open", "");
  expect(refunds).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      orderReference: id(30),
      orderBatchReference: id(31),
      slipReference: "REFUND 7731",
      refundedAt: null,
    },
  ]);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/counter-queue-${width}.png`, fullPage: true });
  }
});

test("@production counter order fails closed without the staff ordering permission", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "request_denied" } }),
  );
  await page.goto("/operations/order-entry");
  await expect(page.getByRole("heading", { name: "No access", exact: true })).toBeVisible();
  await expect(
    page.getByText("You don't have access to this page. Ask the owner or a manager."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send order" })).toHaveCount(0);
});

// v15 run: two of an item with one left returned "try again" without saying why. Staff are told
// which item is short and how many are left; the order stays on the page to fix and send.
test("@production a short item names how many are left and the order stays editable", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  const sent: { sellableReference: string; quantity: number }[][] = [];
  await page.route("**/merchant/counter/orders", (route) => {
    const lines = (route.request().postDataJSON() as { lines: (typeof sent)[number] }).lines;
    sent.push(lines);
    const flatWhites = lines
      .filter((line) => line.sellableReference === id(5))
      .reduce((sum, line) => sum + line.quantity, 0);
    if (flatWhites > 1)
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "item_short", lineIndex: 0, available: 1 },
      });
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "14",
        orderVersion: 1,
        orderMinor: "932",
        tipMinor: "0",
        totalMinor: "932",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    });
  });
  await page.goto("/operations/order-entry");
  for (let count = 0; count < 2; count++) {
    await page.getByRole("button", { name: "Add Flat White" }).click();
    await page.getByRole("button", { name: "Add to order" }).click();
  }
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Only 1 Flat White left, 2 in this order. Remove Flat White and add 1 back, then send again. Nothing was sent or charged.",
  );
  await expect(page.getByText(/item_short|counter_order|409|503/u)).toHaveCount(0);
  const ticket = page.getByRole("list", { name: "Items in this order" });
  await expect(ticket.getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Send order" })).toBeEnabled();
  await page.getByRole("button", { name: "Remove Flat White" }).first().click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $9.32 on the card machine" }),
  ).toBeVisible();
  expect(sent.map((lines) => lines.length)).toEqual([3, 2]);
});

// v15 run (738b4c8b): right after an order was sent the counter menu still offered Flat White
// although the milk left could not make one. The menu is re-read after each send and payment,
// and every 30 s while staff build an order.
test("@production the counter menu re-reads what the store can sell after a send and while building", async ({
  page,
}) => {
  await signIn(page);
  await page.clock.install();
  const soldOut = new Set<string>();
  let menuReads = 0;
  await page.route("**/merchant/counter/menu", (route) => {
    menuReads += 1;
    const current = structuredClone(menu);
    for (const sellable of current.menu.menu.sections[0]?.sellables ?? [])
      if (soldOut.has(sellable.name)) sellable.availability = "SoldOut";
    return route.fulfill({ headers, json: current });
  });
  await page.route("**/merchant/counter/orders", (route) => {
    // The order uses the last of the milk.
    soldOut.add("Flat White");
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "15",
        orderVersion: 1,
        orderMinor: "450",
        tipMinor: "0",
        totalMinor: "450",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    });
  });
  await page.route("**/merchant/orders/card-machine-payment", (route) =>
    route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(20),
        orderBatchReference: id(21),
        amountMinor: "450",
        recordingReason: "AtCounter",
        takenAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        acceptance: "Accepted",
      },
    }),
  );
  await page.goto("/operations/order-entry");
  await page.getByRole("button", { name: "Add Flat White" }).click();
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $4.50 on the card machine" }),
  ).toBeVisible();
  await expect.poll(() => menuReads).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Paid on card machine · $4.50" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Paid and sent to the kitchen." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New counter order" }).click();
  await expect(page.getByRole("button", { name: "Add Flat White" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add Banana Bread" })).toBeEnabled();

  // Banana Bread sells out at another till while staff build the next order.
  soldOut.add("Banana Bread");
  const before = menuReads;
  await page.clock.runFor(30_000);
  await expect.poll(() => menuReads).toBeGreaterThan(before);
  await expect(page.getByRole("button", { name: "Add Banana Bread" })).toBeDisabled();
});
