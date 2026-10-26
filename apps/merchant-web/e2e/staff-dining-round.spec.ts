import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { orderPanel } from "./order-queue-helpers";

// WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): from the Tables page staff take an order for a
// table on behalf of guests who can't or won't use their phone, send it to the table's order,
// charge it on the store's card machine and record it; refusals read in plain staff words.
const id = (n: number) => "01909978-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const price = (amount: string) => ({ status: "Available", amount, currency: "CAD", reason: null });
const tableReference = id(40);
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
      name: "Dine-in menu",
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(4),
          name: "Noodles",
          sellables: [
            {
              sellableReference: id(5),
              productVersionReference: id(6),
              name: "Shoyu Ramen",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [
                {
                  name: "Noodles",
                  bindingReference: id(7),
                  optionSetVersionReference: id(8),
                  minimumSelections: 1,
                  maximumSelections: 1,
                  enabledOptionReferences: [id(9), id(10)],
                  defaultOptionReferences: [id(9)],
                  options: [
                    {
                      optionReference: id(9),
                      name: "Regular",
                      maximumQuantity: 1,
                      conflictOptionReferences: [],
                      selectedByDefault: true,
                      incrementalPrice: price("0.00"),
                    },
                    {
                      optionReference: id(10),
                      name: "Extra noodles",
                      maximumQuantity: 1,
                      conflictOptionReferences: [],
                      selectedByDefault: false,
                      incrementalPrice: price("2.00"),
                    },
                  ],
                },
              ],
              allergenDisclosure: {},
              displayPrice: price("16.00"),
              taxDisplayContext: {},
            },
            {
              sellableReference: id(11),
              productVersionReference: id(12),
              name: "Gyoza",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {},
              displayPrice: price("7.00"),
              taxDisplayContext: {},
            },
            {
              sellableReference: id(13),
              productVersionReference: id(14),
              name: "Matcha Pudding",
              presentationRole: "Standard",
              pinned: false,
              availability: "SoldOut",
              optionRules: [],
              allergenDisclosure: {},
              displayPrice: price("6.00"),
              taxDisplayContext: {},
            },
          ],
        },
      ],
    },
  },
};
const table = {
  tableReference,
  stableLabel: "T4",
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  aggregateVersion: 2,
  currentDiningSessionReference: id(41),
  elapsedMinutes: 25,
  qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
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
            {
              screenId: "OPS-ORDER-ENTRY",
              label: "Counter order",
              href: "/operations/order-entry",
              permission: "ordering.order.create_staff",
            },
            {
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: { canOperateTables: false, items: [table], nextAfterTableReference: null },
    }),
  );
}

/** Words staff and guests must never see: internal codes, references or technical terms. */
async function expectNoInternalText(page: Page) {
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}|DineIn|StoreCardMachine|staff_round|table_cart|OPS-ORDER-ENTRY|DIN-FLOOR-BOARD|undefined|null\b/u,
  );
}

test("@production staff take an order for a table from the Tables page, charge it on the card machine and record it", async ({
  page,
}) => {
  await signIn(page);
  const menuRequests: string[] = [];
  await page.route("**/merchant/counter/menu**", (route) => {
    menuRequests.push(new URL(route.request().url()).search);
    return route.fulfill({ headers, json: menu });
  });
  const rounds: Record<string, unknown>[] = [];
  let guestItemsOnce = true;
  let soldOutOnce = true;
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    rounds.push(body);
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    if (guestItemsOnce) {
      guestItemsOnce = false;
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "table_cart_has_items", items: [{ name: "Iced Latte", quantity: 1 }] },
      });
    }
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
        orderNumber: "7",
        orderVersion: 4,
        tableLabel: "T4",
        orderMinor: "2034",
        tipMinor: "270",
        totalMinor: "2304",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    });
  });
  const payments: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    payments.push(body);
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(20),
        orderBatchReference: id(21),
        amountMinor: "2304",
        recordingReason: "AtCounter",
        takenAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        // WP-2423 D1: the server accepted the paid round with its payment record.
        acceptance: "Accepted",
      },
    });
  });
  const accepted: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/accept", (route) => {
    accepted.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "Created", acceptedOrderVersion: 5 }),
    });
  });

  // Tables → table T4 → Take order.
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T4", exact: true }).click();
  await page.getByRole("link", { name: "Take order for table T4" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Table T4 order" })).toBeVisible();
  await expect(page.getByText(/Dine-in · added to the table's order/u)).toBeVisible();
  // The dine-in menu customers at the table see; sold out items cannot be added.
  expect(menuRequests).toContain("?orderType=DineIn");
  await expect(page.getByRole("button", { name: "Add Matcha Pudding" })).toBeDisabled();

  await page.getByRole("button", { name: "Add Shoyu Ramen" }).click();
  await page.getByRole("radio", { name: /Extra noodles/ }).check();
  await page
    .getByRole("textbox", { name: "Note for the kitchen (optional)" })
    .fill("No green onion");
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Add Gyoza" }).click();
  await page.getByRole("button", { name: "Add to order" }).click();
  const ticket = page.getByRole("list", { name: "Items in this order" });
  await expect(ticket).toContainText("1 × Shoyu Ramen · Extra noodles · Note: No green onion");
  await page.getByRole("radio", { name: "15%" }).check();

  // A guest left items in the table's shared cart: staff are told what, in plain words.
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Guests at this table have items in their shared cart that haven't been sent (1 × Iced Latte).",
  );
  // Gyoza sold out meanwhile: named, nothing charged.
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Gyoza can't be sold right now (sold out or off the menu).",
  );
  await page.getByRole("button", { name: "Remove Gyoza" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $23.04 on the card machine" }),
  ).toBeVisible();
  // The browser sends intent only: table, items, options, note and tip choice — never amounts.
  expect(rounds.at(-1)).toEqual({
    operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    tableReference,
    lines: [
      {
        sellableReference: id(5),
        quantity: 1,
        optionSelections: [{ optionReference: id(10), quantity: 1 }],
        note: "No green onion",
      },
    ],
    tip: { kind: "Percent", percent: 15 },
    recordedAfterOutage: false,
  });
  await expect(
    page.getByText(
      /Record the payment by .+ The kitchen starts this order once it is recorded here; if it isn't recorded by then, the round is cancelled\./u,
    ),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Slip reference (optional)" }).fill("AUTH 771204");
  await expectNoInternalText(page);

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(
      page.getByRole("heading", { name: "Charge $23.04 on the card machine" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/staff-dining-round-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);

  await page.getByRole("button", { name: "Paid on card machine · $23.04" }).click();
  await expect(page.getByRole("heading", { name: "Table T4 order paid" })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Paid and sent to the kitchen." }),
  ).toBeVisible();
  expect(payments).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      orderReference: id(20),
      orderBatchReference: id(21),
      expectedTotalMinor: "2304",
      slipReference: "AUTH 771204",
      takenAt: null,
    },
  ]);
  // WP-2423 D1: the page never accepts on its own (the server did, at the Order's version).
  expect(accepted).toEqual([]);
  await expectNoInternalText(page);
  await expect(page.getByRole("link", { name: "Back to Tables" })).toBeVisible();
});

test("@production the order queue marks a round entered by staff and its card-machine payment", async ({
  page,
}) => {
  await signIn(page);
  const batch = (sequence: number, extra: Record<string, unknown>) => ({
    orderBatchReference: id(30 + sequence),
    sequence,
    acceptanceStatus: "Accepted",
    canRequestAcceptance: false,
    canCancel: false,
    canCancelItems: false,
    staffCancellation: null,
    paymentDue: null,
    staffRound: null,
    ...extra,
  });
  const payments: Record<string, unknown>[] = [];
  const detailReads: string[] = [];
  // The list leaves an unpaid round's amount out; the one-order read gives it (WP-2423 D5).
  const listed = (amountDueMinor: string | null = null) => ({
    items: [
      {
        orderReference: id(30),
        orderNumber: "7",
        orderType: "DineIn",
        sourceChannel: "Qr",
        submittedAt: "2026-10-15T16:00:00.000Z",
        observedAt: "2026-10-15T16:30:00.000Z",
        initialBatchReference: id(31),
        counter: null,
        paidOnline: { amountMinor: "1130", currencyCode: "CAD" },
        batches: [
          batch(1, {}),
          batch(2, {
            staffRound: {
              recordedAfterOutage: false,
              paidOnCardMachine: { amountMinor: "2304", takenAt: "2026-10-15T16:20:00.000Z" },
            },
          }),
          // WP-2423 D5: unpaid until staff record it from Orders; then paid and accepted.
          payments.length === 0
            ? batch(3, {
                acceptanceStatus: "NotAccepted",
                // WP-2423 item 5: no payment started, so it is cancelled at its deadline if unpaid.
                paymentDue: { status: "Awaiting", cancelsAt: "2099-10-15T16:50:00.000Z" },
                staffRound: {
                  recordedAfterOutage: false,
                  paidOnCardMachine: null,
                  amountDueMinor,
                },
              })
            : batch(3, {
                staffRound: {
                  recordedAfterOutage: false,
                  paidOnCardMachine: { amountMinor: "1695", takenAt: "2026-10-15T16:40:00.000Z" },
                  amountDueMinor: null,
                },
              }),
        ],
        canRequestAcceptance: false,
        currentPhase: "InProgress",
        currentVersion: 6,
        unfulfillable: null,
        pickupNotCollected: false,
        acceptBy: null,
        awaitingPayment: false,
      },
    ],
    nextAfterOrderReference: null,
  });
  await page.route("**/merchant/orders?*", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders/detail?*", (route) => {
    detailReads.push(new URL(route.request().url()).searchParams.get("order") ?? "");
    const order = listed(payments.length === 0 ? "1695" : null).items[0];
    return route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order,
        lines: {
          items: [
            {
              orderItemReference: id(39),
              orderBatchReference: id(33),
              name: "Synthetic noodles",
              options: [],
              quantity: 1,
              customerNote: null,
              unitPrice: { amountMinor: "1500", currencyCode: "CAD" },
              subtotal: { amountMinor: "1500", currencyCode: "CAD" },
              discount: { amountMinor: "0", currencyCode: "CAD" },
              tax: { amountMinor: "195", currencyCode: "CAD" },
              fee: { amountMinor: "0", currencyCode: "CAD" },
              total: { amountMinor: "1695", currencyCode: "CAD" },
              canCancel: false,
              cancellation: null,
            },
          ],
          totals: {
            subtotal: { amountMinor: "1500", currencyCode: "CAD" },
            discount: { amountMinor: "0", currencyCode: "CAD" },
            tax: { amountMinor: "195", currencyCode: "CAD" },
            fee: { amountMinor: "0", currencyCode: "CAD" },
            total: { amountMinor: "1695", currencyCode: "CAD" },
            // WP-2423 (3cd0f8dd M1): the tip the order's payments carried.
            tip: { amountMinor: "270", currencyCode: "CAD" },
          },
        },
      },
    });
  });
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    payments.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(30),
        orderBatchReference: id(33),
        amountMinor: "1695",
        recordingReason: "AtCounter",
        takenAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        acceptance: "Accepted",
      },
    });
  });
  await page.goto("/operations/orders");
  const row = page.locator("li.order-row").first();
  await expect(row).toContainText(
    /Round 3: Entered by staff · record the card-machine payment by \d\d:\d\d or it is cancelled/u,
  );
  if ((await row.getAttribute("data-open")) !== "true")
    await row.locator(".order-row__open").click();
  const entry = orderPanel(page);
  await expect(
    entry.getByRole("heading", { name: "Round 2 · Added round · Entered by staff" }),
  ).toBeVisible();
  // WP-2423 D5: the order shows the card-machine total apart from what was paid online.
  const payment = entry.locator(".order-panel__facts");
  await expect(payment).toContainText("Paid online $11.30");
  await expect(payment).toContainText("Paid on card machine $23.04");
  await expect(entry.getByText(/the guest has not paid/u)).toHaveCount(0);
  // WP-2423 (3cd0f8dd M1): the order's tip, and a total that includes it (what was paid).
  const totals = entry.locator(".order-lines-totals").first();
  await expect(totals).toContainText("Tip$2.70");
  await expect(totals).toContainText("Total$19.65");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await expect(page.getByText(/cancelled automatically/u)).toHaveCount(0);
  await expectNoInternalText(page);
  // WP-2423 D5: the unpaid staff round is recorded as paid from Orders.
  await page.setViewportSize({ width: 1440, height: 900 });
  // The list carries no amount; opening the form reads it for this one order.
  await entry.getByRole("button", { name: "Record card-machine payment", exact: true }).click();
  await expect(
    entry.getByText("Charge $16.95 on the card machine first", { exact: false }),
  ).toBeVisible();
  expect(detailReads.filter((order) => order === id(30)).length).toBeGreaterThan(0);
  await entry.getByRole("textbox", { name: "Slip reference (optional)" }).fill("AUTH 771205");
  await entry.getByRole("button", { name: "Paid on card machine · $16.95" }).click();
  // The list reloads: the round is paid on the card machine and no longer asks for payment.
  await expect(payment).toContainText("Paid on card machine $39.99");
  await expect(entry.getByRole("button", { name: /Record card-machine payment/u })).toHaveCount(0);
  expect(payments).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      orderReference: id(30),
      orderBatchReference: id(33),
      expectedTotalMinor: "1695",
      slipReference: "AUTH 771205",
      takenAt: null,
    },
  ]);
});

test("@production the Tables page warns before a staff round's payment time ends (WP-2423 item 5)", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-15T16:25:00.000Z"));
  await signIn(page);
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        items: [{ ...table, staffRoundsAwaitingPayment: [{ payBy: "2026-10-15T16:30:00.000Z" }] }],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.goto("/operations/dining");
  const tile = page.locator("article.dining-table-tile").first();
  await expect(tile.getByRole("alert")).toHaveText(
    "5 min left: record the card-machine payment for the round entered by staff by 12:30, or it is cancelled.",
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/staff-round-payment-warning-${width}.png` });
  }
  await expectNoInternalText(page);
});

test("@production a table without a QR code can't take a staff order; staff are told why and where to fix it", async ({
  page,
}) => {
  await signIn(page);
  // DEC-STAFF-DINE-IN-ROUND (2026-10-15): T5 never had a code created (v15 DEMO-01/03).
  const bare = {
    ...table,
    tableReference: id(77),
    stableLabel: "T5",
    currentDiningSessionReference: null,
    elapsedMinutes: null,
    qrCodeValidUntil: null,
  };
  await page.unroute("**/merchant/dining/tables");
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: { canOperateTables: false, items: [table, bare], nextAfterTableReference: null },
    }),
  );
  const rounds: unknown[] = [];
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    rounds.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, headers, json: { error: "table_qr_missing" } });
  });
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T5", exact: true }).click();
  const section = page.getByRole("region", { name: "Take an order for this table" });
  await expect(section).toContainText(
    "Orders can't be taken for table T5 yet: it has no table QR code. Ask a manager to create one on the Table QR codes page, then take the order.",
  );
  await expect(section.getByRole("link", { name: /Take order for table/u })).toHaveCount(0);
  // WP-2423 item 7: no dining session is offered either: guests join by scanning the table's QR.
  await expect(page.getByRole("button", { name: "Start dining session", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("region", { name: "Dining session action" })).toContainText(
    "A dining session can't be started for table T5 yet: it has no table QR code, so guests can't join. Ask a manager to create one on the Table QR codes page.",
  );
  await expectNoInternalText(page);
  // Opened directly (old bookmark): the order page says the same before anything is sent.
  await page.goto(`/operations/order-entry?table=${id(77)}`);
  await expect(
    page.getByText("This table has no table QR code yet", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Table QR codes", exact: true })).toHaveCount(0);
  expect(rounds).toHaveLength(0);

  // WP-2423 item 7: staff who can create codes (the Owner) get the link on both pages, the same
  // rule as the Tables panel.
  await page.unroute("**/merchant/session");
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
              screenId: "OPS-ORDER-ENTRY",
              label: "Counter order",
              href: "/operations/order-entry",
              permission: "ordering.order.create_staff",
            },
            {
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
            {
              screenId: "DIN-TABLE-LIST",
              label: "Table QR codes",
              href: "/app/operations/tables",
              permission: "dining.table.qr.manage",
            },
          ],
        },
      },
    }),
  );
  await page.goto(`/operations/order-entry?table=${id(77)}`);
  const panel = page.getByRole("status").filter({ hasText: "This table has no table QR code yet" });
  await expect(panel).toContainText(
    "Orders for a table use its code. Create one on Table QR codes (it can be printed later), then take the order.",
  );
  await expect(panel.getByRole("link", { name: "Table QR codes", exact: true })).toHaveAttribute(
    "href",
    "/app/operations/tables",
  );
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T5", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Dining session action" })
      .getByRole("link", { name: "Table QR codes", exact: true }),
  ).toBeVisible();
  await expectNoInternalText(page);
  expect(rounds).toHaveLength(0);
});

// WP-2423 (2026-10-17): a table round the store's stock can't make as entered — two Gyoza where the
// filling left makes one with the Ramen also using it — names the item and how many are left, keeps
// the round as entered and sends or charges nothing; staff lower it and send again.
test("@production a table round short on stock names the item and how many are left, nothing charged", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  const sent: { sellableReference: string; quantity: number }[][] = [];
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    const body = route.request().postDataJSON() as {
      lines: { sellableReference: string; quantity: number }[];
    };
    sent.push(body.lines);
    if (sent.length === 1)
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "item_short", lineIndex: 1, available: 1, sharedStock: true },
      });
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "8",
        orderVersion: 4,
        tableLabel: "T4",
        orderMinor: "2599",
        tipMinor: "0",
        totalMinor: "2599",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    });
  });
  const payments: unknown[] = [];
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    payments.push(route.request().postDataJSON());
    return route.abort();
  });

  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T4", exact: true }).click();
  await page.getByRole("link", { name: "Take order for table T4" }).click();
  await page.getByRole("button", { name: "Add Shoyu Ramen" }).click();
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Add Gyoza" }).click();
  await page.getByRole("spinbutton", { name: "Quantity" }).fill("2");
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText(
    "Only 1 Gyoza can be made with the rest of this order (other items use the same ingredients). Lower Gyoza to 1 or change the other items, then send again. Nothing was sent or charged.",
  );
  // The round stays as entered; nothing was charged and no payment can be recorded for it.
  const ticket = page.getByRole("list", { name: "Items in this order" });
  await expect(ticket.getByRole("listitem")).toHaveCount(2);
  await expect(ticket).toContainText("2 × Gyoza");
  await expect(page.getByRole("button", { name: /Paid on card machine/u })).toHaveCount(0);
  await expect(page.getByText(/item_short|staff_round|409|503/u)).toHaveCount(0);
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(alert).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/staff-round-item-short-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // Staff lower Gyoza to 1 and send again: the round goes through.
  await page.getByRole("button", { name: "Remove Gyoza" }).click();
  await page.getByRole("button", { name: "Add Gyoza" }).click();
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $25.99 on the card machine" }),
  ).toBeVisible();
  expect(sent.map((lines) => lines.map((line) => line.quantity))).toEqual([
    [1, 2],
    [1, 1],
  ]);
  expect(payments).toEqual([]);
});

// WP-2423: a table round the server could not send said "no answer, resend" and the resend kept
// failing. Staff now see that it was a system problem with nothing charged, and the next send is a
// new attempt; a gateway failure without the server's answer still resends the same round.
test("@production a table round the system could not send says so plainly, then sends as a new round", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  const operations: string[] = [];
  const replies = [
    { status: 503, json: { error: "staff_round_unavailable" } },
    { status: 502, json: {} },
  ];
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    operations.push(
      (route.request().postDataJSON() as { operationReference: string }).operationReference,
    );
    const refusal = replies.shift();
    if (refusal !== undefined) return route.fulfill({ ...refusal, headers });
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "8",
        orderVersion: 4,
        tableLabel: "T4",
        orderMinor: "1599",
        tipMinor: "0",
        totalMinor: "1599",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T4", exact: true }).click();
  await page.getByRole("link", { name: "Take order for table T4" }).click();
  await page.getByRole("button", { name: "Add Shoyu Ramen" }).click();
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "The system couldn't send this round for Table T4 (a problem on our side, not with the order). Nothing was sent to the kitchen or charged. Send it once more. If it fails again, take the order on paper, charge it on the card machine and enter it under Paper order later. Home shows any alert.",
  );
  await expect(page.getByText(/staff_round|503/u)).toHaveCount(0);
  await expectNoInternalText(page);
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "No answer from the system. Send again — the same order is never created twice.",
  );
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $15.99 on the card machine" }),
  ).toBeVisible();
  // A new attempt after the system problem; the same round resent after no answer.
  expect(operations).toHaveLength(3);
  expect(operations[1]).not.toBe(operations[0]);
  expect(operations[2]).toBe(operations[1]);
});
