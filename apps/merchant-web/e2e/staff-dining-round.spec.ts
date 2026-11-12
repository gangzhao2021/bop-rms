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

async function signIn(
  page: Page,
  tableItem: Record<string, unknown> = table,
  {
    counterOrder = true,
    tables = {},
  }: { readonly counterOrder?: boolean; readonly tables?: Record<string, unknown> } = {},
) {
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
            // WP-2423 M08: the full-service setting (counter ordering off) does not list it.
            ...(counterOrder
              ? [
                  {
                    screenId: "OPS-ORDER-ENTRY",
                    label: "Counter order",
                    href: "/operations/order-entry",
                    permission: "ordering.order.create_staff",
                  },
                ]
              : []),
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
  // WP-2423 M35: the table's unsent guest lines, read before staff send (none unless a test says).
  await page.route("**/merchant/dining/sessions/table-cart", (route) =>
    route.fulfill({ headers, json: { cart: null } }),
  );
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        items: [tableItem],
        nextAfterTableReference: null,
        ...tables,
      },
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
        // WP-2423 item 8 ⑦ (v15 finding t): after last orders guests can't send it themselves.
        json: {
          error: "table_cart_has_items",
          items: [
            {
              cartItemReference: id(60),
              name: "Iced Latte",
              quantity: 1,
              standing: "Available",
            },
          ],
          cartVersion: 5,
          guestsCanSend: false,
        },
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
  const ticket = page.getByRole("list", { name: "Items in this order" });
  await expect(ticket).toContainText("1 × Shoyu Ramen · Extra noodles · Note: No green onion");
  await page.getByRole("radio", { name: "15%" }).check();

  // A guest left items in the table's shared cart: staff are told what, in plain words.
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Guests at this table have items in their shared cart that haven't been sent (1 × Iced Latte), and guests can no longer send them after last orders. Add them to this round to order them.",
  );
  await expect(page.getByRole("alert")).not.toContainText("Ask them to send");
  // Staff add them to this round, as shown (that cart version), as a new request.
  await page.getByRole("button", { name: "Add them to this round" }).click();
  expect(rounds.at(-1)).toMatchObject({ includeTableCart: { expectedCartVersion: 5 } });
  expect(rounds.at(-1)?.operationReference).not.toBe(rounds.at(-2)?.operationReference);
  // Gyoza sold out meanwhile: named, nothing charged.
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
    // v15 staff-round-speed: the party seated when the first dish went on.
    expectedDiningSessionReference: id(41),
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
    // Orders v3: each round is headed by its number, staff entry and time.
    entry.getByRole("heading", { name: /^Round 2 · Entered by staff/u }),
  ).toBeVisible();
  // WP-2423 D5: the order shows the card-machine total apart from what was paid online.
  const payment = entry.locator(".order-panel__payment");
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
  // Orders v3: the round under its items already knows its amount (read with the order's items).
  await entry
    .getByRole("button", { name: "Record card-machine payment · $16.95", exact: true })
    .click();
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
  // WP-2423 item 8 ①: the list row counts down (red); the table's panel says what to do.
  const tile = page.locator(".table-row").first();
  await expect(tile).toContainText(/Round not paid yet\s*5 min left/u);
  await expect(tile).toHaveAttribute("data-urgent", "true");
  await tile.getByRole("button", { name: /^Select /u }).click();
  await expect(page.getByRole("complementary", { name: "Selected table details" })).toContainText(
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

// v15 batch 8: in Chinese the selected table's notice is Chinese throughout (no "awaits").
test("@production the Tables page's staff round notice reads as whole Chinese sentences, at 1440, 1024 and 390", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("bop.merchant.language", "zh-Hans");
  });
  await page.clock.setFixedTime(new Date("2026-10-15T16:00:00.000Z"));
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
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/operations/dining");
    await page
      .locator(".table-row")
      .first()
      .getByRole("button", { name: /^选择 /u })
      .click();
    const panel = page.getByRole("complementary");
    await expect(panel).toContainText(
      "员工录入的一轮正在等待刷卡机付款。请在 12:30 前记录；记录后后厨才开始制作。",
    );
    await expect(panel).not.toContainText(/awaits|await\b| at \d/u);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
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
  const section = page.getByRole("region", { name: "Open this table" });
  await expect(section).toContainText(
    "Table T5 has no table QR code yet, so guests can't join it and orders can't be taken for it. Ask a manager to create one on the Table QR codes page.",
  );
  await expect(page.getByRole("link", { name: /Take order for table/u })).toHaveCount(0);
  // WP-2423 item 7: the table isn't opened either: guests join by scanning the table's QR.
  await expect(page.getByRole("button", { name: "Open table", exact: true })).toHaveCount(0);
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
      .getByRole("region", { name: "Open this table" })
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
  await page.getByRole("button", { name: "Add Gyoza" }).click();
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

test("@production DEC-DINE-IN-PAY-LATER: a pay-later table's round goes to the kitchen with nothing to charge", async ({
  page,
}) => {
  await signIn(page, { ...table, paymentTiming: "PayLater" });
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  const rounds: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    rounds.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "7",
        orderVersion: 5,
        tableLabel: "T4",
        orderMinor: "2034",
        tipMinor: "0",
        totalMinor: "2034",
        payBy: null,
        payLater: true,
        recordedAfterOutage: false,
      },
    });
  });
  let charged = false;
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    charged = true;
    return route.abort();
  });

  await page.goto("/operations/order-entry?table=" + tableReference);
  await expect(page.getByRole("heading", { level: 1, name: "Table T4 order" })).toBeVisible();
  // The table chooses its tip once, when it pays at the end.
  await expect(page.getByRole("group", { name: "Tip" })).toHaveCount(0);
  await page.getByRole("button", { name: "Add Gyoza" }).click();
  await expect(
    page.getByText(/goes on the table's bill; the table pays once at the end/u),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Table T4 round sent to the kitchen" }),
  ).toBeVisible();
  await expect(page.getByText("Nothing to charge now.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /Paid on card machine/u })).toHaveCount(0);
  expect(rounds.at(-1)).toMatchObject({ tip: { kind: "None" } });
  expect(charged).toBe(false);
  await expectNoInternalText(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/staff-dining-round-pay-later-${width}.png`,
      fullPage: true,
    });
  }
});

/**
 * WP-2423 (staff-round-soldout, v15 8911a4c1 M06): a guest's plum juice in the table's shared cart
 * sold out. Staff see it marked, remove it and send the rest with their round; the guests are to
 * be told. Never "the system couldn't send".
 */
async function guestCartSoldOut(
  page: Page,
  items: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  const rounds: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    rounds.push(body);
    if (rounds.length === 1)
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "table_cart_has_items", items, cartVersion: 6, guestsCanSend: true },
      });
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "7",
        orderVersion: 5,
        tableLabel: "T4",
        orderMinor: "2034",
        tipMinor: "0",
        totalMinor: "2034",
        payBy: null,
        payLater: true,
        recordedAfterOutage: false,
      },
    });
  });
  return rounds;
}
const plumJuice = {
  cartItemReference: id(61),
  name: "Plum juice",
  quantity: 1,
  standing: "Unavailable",
};
const noodles = {
  cartItemReference: id(62),
  name: "Hand-pulled noodles",
  quantity: 2,
  standing: "Available",
};

test("@production a guest's sold-out item is marked; staff remove it and send the rest of the table's cart", async ({
  page,
}) => {
  await signIn(page, { ...table, paymentTiming: "PayLater" });
  const rounds = await guestCartSoldOut(page, [plumJuice, noodles]);
  await page.goto("/operations/order-entry?table=" + tableReference);
  await expect(page.getByRole("heading", { level: 1, name: "Table T4 order" })).toBeVisible();
  await page.getByRole("button", { name: "Add Gyoza" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Guests at this table have items in their shared cart that haven't been sent. Plum juice can't be served now. Remove it from their order, or ask the guests to change their order on their phone.",
  );
  const guestItems = page.getByRole("list", { name: "Guests' items not sent yet" });
  await expect(guestItems.getByRole("listitem")).toHaveText([
    "1 × Plum juiceSold out or off the menu now",
    "2 × Hand-pulled noodles",
  ]);
  await expect(page.getByRole("button", { name: "Add them to this round" })).toHaveCount(0);
  await expectNoInternalText(page);
  await expectAccessible(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(guestItems).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/staff-dining-round-guest-sold-out-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("button", { name: "Remove Plum juice and add the rest to this round" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Table T4 round sent to the kitchen" }),
  ).toBeVisible();
  expect(rounds).toHaveLength(2);
  expect(rounds[1]).toMatchObject({
    tableReference,
    includeTableCart: { expectedCartVersion: 6, removeUnavailable: [id(61)] },
  });
  await expect(page.getByRole("note").filter({ hasText: "Tell the guests" })).toHaveText(
    "Tell the guests: Plum juice isn't available now, so it was taken off their order.",
  );
  await expectNoInternalText(page);
  await page.screenshot({
    path: "test-results/staff-dining-round-guest-sold-out-sent.png",
    fullPage: true,
  });
});

test("@production every guest item sold out: staff remove them and send just this round, in Chinese too", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("bop.merchant.language", "zh-Hans");
  });
  await signIn(page, { ...table, paymentTiming: "PayLater" });
  const rounds = await guestCartSoldOut(page, [
    { ...plumJuice, name: "酸梅汤" },
    { ...noodles, name: "手拉面", standing: "OptionsChanged" },
  ]);
  await page.goto("/operations/order-entry?table=" + tableReference);
  await expect(page.getByRole("heading", { level: 1, name: "桌台 T4 的订单" })).toBeVisible();
  await page.getByRole("button", { name: "添加Gyoza" }).click();
  await page.getByRole("button", { name: "发送订单" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "这桌客人的共用购物车里还有没送出的菜。酸梅汤、手拉面 现在不供应。可以把它们从他们的点单里删掉，或者请客人在手机上修改。",
  );
  const guestItems = page.getByRole("list", { name: "客人还没送出的菜" });
  await expect(guestItems.getByRole("listitem")).toHaveText([
    "1 × 酸梅汤现在不供应",
    "2 × 手拉面可选项已变，需要重新选",
  ]);
  await expectNoInternalText(page);
  await expectAccessible(page);
  await page.screenshot({
    path: "test-results/staff-dining-round-guest-sold-out-zh.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "删掉酸梅汤、手拉面，送出这一轮" }).click();
  await expect(page.getByRole("heading", { name: "T4 桌这一轮已送厨房" })).toBeVisible();
  expect(rounds[1]).toMatchObject({
    includeTableCart: { expectedCartVersion: 6, removeUnavailable: [id(61), id(62)] },
  });
  await expect(page.getByRole("note").filter({ hasText: "请告诉客人" })).toHaveText(
    "请告诉客人：酸梅汤、手拉面 现在不供应，已从他们的点单里删掉。",
  );
});

test("@production a guest item with too few left: staff ask the guests, nothing to remove", async ({
  page,
}) => {
  await signIn(page, { ...table, paymentTiming: "PayLater" });
  const rounds = await guestCartSoldOut(page, [{ ...noodles, standing: "Short", available: 1 }]);
  await page.goto("/operations/order-entry?table=" + tableReference);
  await page.getByRole("button", { name: "Add Gyoza" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Hand-pulled noodles has only 1 left. Ask the guests to lower it on their phone, then send again. Nothing was sent or charged.",
  );
  await expect(
    page.getByRole("list", { name: "Guests' items not sent yet" }).getByRole("listitem"),
  ).toHaveText(["2 × Hand-pulled noodlesOnly 1 left"]);
  await expect(page.getByRole("button", { name: /Remove .+ (round|rest)/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add them to this round" })).toHaveCount(0);
  expect(rounds).toHaveLength(1);
  await expectNoInternalText(page);
});

/** WP-2423 M08: the Store's business day, guests' last orders 20 minutes ago. */
async function pastLastOrders(page: Page) {
  const now = Date.now();
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-15",
        startsAt: new Date(now - 18 * 3_600_000).toISOString(),
        endsAt: new Date(now + 6 * 3_600_000).toISOString(),
        timeZone: "America/Toronto",
        observedAt: new Date(now).toISOString(),
        lastOrdersAt: new Date(now - 20 * 60_000).toISOString(),
      },
    }),
  );
}

/** A pay-later table's round that the server sent to the kitchen. */
async function placesRounds(page: Page) {
  const rounds: Record<string, unknown>[] = [];
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    rounds.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "7",
        orderVersion: 5,
        tableLabel: "T4",
        orderMinor: "700",
        tipMinor: "0",
        totalMinor: "700",
        payBy: null,
        payLater: true,
        recordedAfterOutage: false,
      },
    });
  });
  return rounds;
}

async function expectAccessible(page: Page) {
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);
}

test("@production M08: with counter ordering off and after last orders, staff still send a round for a table", async ({
  page,
}) => {
  await signIn(
    page,
    { ...table, paymentTiming: "PayLater" },
    { counterOrder: false, tables: { canTakeTableRounds: true } },
  );
  await pastLastOrders(page);
  const rounds = await placesRounds(page);

  await page.goto("/operations/dining");
  // The last-orders banner's promise holds: guests stopped, staff can still add a round.
  await expect(page.locator(".last-orders-notice")).toContainText(
    "(last orders). You can still add a round for a table.",
  );
  // Walk-up counter ordering is off: no "Counter order" in the sidebar.
  await expect(page.getByRole("link", { name: "Counter order", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Select T4", exact: true }).click();
  await expectNoInternalText(page);
  await expectAccessible(page);
  await page.getByRole("link", { name: "Take order for table T4" }).click();
  // The table's order page, not sent back to Tables.
  await expect(page).toHaveURL(new RegExp("/operations/order-entry\\?table=" + tableReference));
  await expect(page.getByRole("heading", { level: 1, name: "Table T4 order" })).toBeVisible();
  // Staff can tell where they are: Tables is the current page.
  await expect(page.getByRole("link", { name: "Tables", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "Add Gyoza" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Table T4 round sent to the kitchen" }),
  ).toBeVisible();
  expect(rounds).toHaveLength(1);
  expect(rounds[0]).toMatchObject({ tableReference, tip: { kind: "None" } });
  await expectNoInternalText(page);
  await expectAccessible(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(
      page.getByRole("heading", { name: "Table T4 round sent to the kitchen" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/staff-dining-round-counter-off-${width}.png`,
      fullPage: true,
    });
  }
});

test("@production M08: the table round reads in the staff member's language with counter ordering off", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("bop.merchant.language", "zh-Hans");
  });
  await signIn(
    page,
    { ...table, paymentTiming: "PayLater" },
    { counterOrder: false, tables: { canTakeTableRounds: true } },
  );
  await placesRounds(page);
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "选择 T4", exact: true }).click();
  await page.getByRole("link", { name: "为桌台 T4 点单" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "桌台 T4 的订单" })).toBeVisible();
  await expect(page.getByRole("link", { name: "柜台点单", exact: true })).toHaveCount(0);
  await expectNoInternalText(page);
  await expectAccessible(page);
});

test("@production M08: no table round is offered when the Tables read says this staff member can't take one", async ({
  page,
}) => {
  await signIn(page, table, { counterOrder: false, tables: { canTakeTableRounds: false } });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T4", exact: true }).click();
  await expect(page.getByText("Manage this table")).toBeVisible();
  await expect(page.getByRole("link", { name: "Take order for table T4" })).toHaveCount(0);
  await expectNoInternalText(page);
  await expectAccessible(page);
});

test("@production M08: with counter ordering off the walk-up order address still goes to Tables", async ({
  page,
}) => {
  await signIn(page, table, { counterOrder: false, tables: { canTakeTableRounds: true } });
  await page.goto("/operations/order-entry");
  await expect(page).toHaveURL(/\/operations\/dining$/u);
  await expect(page.getByRole("button", { name: "Select T4", exact: true })).toBeVisible();
  await expectNoInternalText(page);
  await expectAccessible(page);
});

/** WP-2423 M35: one of the guests' unsent lines as the table cart read returns it. */
const guestLine = (n: number, sellable: number, change: Record<string, unknown> = {}) => ({
  cartItemReference: id(n),
  sellableReference: id(sellable),
  optionSelections: [],
  names: {},
  quantity: 1,
  withOptions: false,
  phoneNumber: 1,
  phoneLeft: false,
  ...change,
});
const placedRound = {
  status: "Placed",
  orderReference: id(20),
  orderBatchReference: id(21),
  orderNumber: "7",
  orderVersion: 5,
  tableLabel: "T4",
  orderMinor: "3164",
  tipMinor: "0",
  totalMinor: "3164",
  payBy: null,
  payLater: true,
  recordedAfterOutage: false,
};

test("@production M35: staff see the guests' unsent lines before sending, take some out and send the rest in one request", async ({
  page,
}) => {
  await signIn(page, { ...table, paymentTiming: "PayLater" });
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  const reads: unknown[] = [];
  await page.route("**/merchant/dining/sessions/table-cart", (route) => {
    reads.push(route.request().postDataJSON());
    return route.fulfill({
      headers,
      json: {
        cart: {
          cartReference: id(70),
          cartVersion: 4,
          guestPaying: false,
          lines: [
            guestLine(81, 11, { quantity: 2 }),
            guestLine(82, 13, { phoneNumber: 2, phoneLeft: true }),
            guestLine(83, 5, { optionSelections: [{ optionReference: id(10), quantity: 1 }] }),
          ],
        },
      },
    });
  });
  const rounds: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    rounds.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ headers, json: placedRound });
  });
  await page.goto("/operations/order-entry?table=" + tableReference);
  await expect(page.getByRole("heading", { level: 1, name: "Table T4 order" })).toBeVisible();
  const guests = page.getByRole("list", { name: "From the guests' phones (not sent yet)" });
  // On screen before anything is sent, named and priced from the menu, with whose phone.
  await expect(guests.getByRole("listitem")).toHaveCount(3);
  await expect(guests.getByRole("listitem").nth(0)).toContainText("2 × Gyoza · Phone 1");
  await expect(guests.getByRole("listitem").nth(0)).toContainText("$14.00");
  await expect(guests.getByRole("listitem").nth(1)).toContainText(
    "1 × Matcha Pudding · Phone 2 has leftSold out or off the menu now. It is taken out.",
  );
  await expect(guests.getByRole("listitem").nth(2)).toContainText(
    "1 × Shoyu Ramen · Extra noodles · Phone 1",
  );
  // The sold-out pudding can't be sent: it is taken out, with nothing to press.
  await expect(guests.getByRole("listitem").nth(1).getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Add Gyoza" }).click();
  // The guest asked staff to drop the ramen; staff can put it back before sending.
  await page.getByRole("button", { name: "Take Shoyu Ramen out of this round" }).click();
  await expect(guests.getByRole("listitem").nth(2)).toContainText("Taken out");
  await page.getByRole("button", { name: "Send Shoyu Ramen with this round" }).click();
  await page.getByRole("button", { name: "Take Shoyu Ramen out of this round" }).click();
  const totals = page.locator(".counter-order__totals");
  await expect(totals).toContainText("Your items$7.00");
  await expect(totals).toContainText("From the guests' phones$14.00");
  await expect(totals).toContainText("Estimated subtotal$21.00");
  await expectNoInternalText(page);
  await expectAccessible(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(guests).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/staff-dining-round-guest-lines-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Table T4 round sent to the kitchen" }),
  ).toBeVisible();
  // One request: the decisions go with the round, against the cart version read.
  expect(rounds).toHaveLength(1);
  expect(rounds[0]).toMatchObject({
    tableReference,
    includeTableCart: {
      expectedCartVersion: 4,
      lines: [
        { cartItemReference: id(81), decision: "Send" },
        { cartItemReference: id(82), decision: "Remove", reason: "CantMake" },
        { cartItemReference: id(83), decision: "Remove", reason: "GuestAsked" },
      ],
    },
  });
  expect(reads[0]).toEqual({ action: "Read", diningSessionReference: id(41) });
  await expect(page.getByRole("note").filter({ hasText: "Tell the guests" })).toHaveText(
    "Tell the guests: Matcha Pudding isn't available now, so it was taken off their order. Removed from the guests' cart: Shoyu Ramen.",
  );
  await expectNoInternalText(page);
});

test("@production M35: a cart guests changed just before the send is read again, nothing sent; in Chinese", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("bop.merchant.language", "zh-Hans");
  });
  await signIn(page, { ...table, paymentTiming: "PayLater" });
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  let version = 4;
  await page.route("**/merchant/dining/sessions/table-cart", (route) =>
    route.fulfill({
      headers,
      json: {
        cart: {
          cartReference: id(70),
          cartVersion: version,
          guestPaying: false,
          lines: [
            guestLine(81, 11, { quantity: 2 }),
            ...(version > 4 ? [guestLine(84, 5, { phoneNumber: 3 })] : []),
          ],
        },
      },
    }),
  );
  const rounds: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    rounds.push(route.request().postDataJSON() as Record<string, unknown>);
    if (rounds.length === 1) {
      // A guest added a ramen a moment before.
      version = 5;
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "table_cart_has_items", items: [], cartVersion: 5, guestsCanSend: true },
      });
    }
    return route.fulfill({ headers, json: placedRound });
  });
  await page.goto("/operations/order-entry?table=" + tableReference);
  await expect(page.getByRole("heading", { level: 1, name: "桌台 T4 的订单" })).toBeVisible();
  const guests = page.getByRole("list", { name: "客人手机上还没送出的菜" });
  await expect(guests.getByRole("listitem")).toHaveCount(1);
  await expect(page.locator(".counter-order__totals")).toContainText("客人手机上的$14.00");
  await page.getByRole("button", { name: "发送订单" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "客人刚改了购物车。请再看一下清单后发送。没有下单，也没有收款。",
  );
  await expect(guests.getByRole("listitem")).toHaveCount(2);
  await expect(guests.getByRole("listitem").nth(1)).toContainText("1 × Shoyu Ramen · 手机 3");
  await expectNoInternalText(page);
  await expectAccessible(page);
  await page.screenshot({
    path: "test-results/staff-dining-round-guest-lines-changed-zh.png",
    fullPage: true,
  });
  // Sent with staff's own dish? None: the guests' lines alone go as the round.
  await page.getByRole("button", { name: "发送订单" }).click();
  await expect(page.getByRole("heading", { name: "T4 桌这一轮已送厨房" })).toBeVisible();
  expect(rounds).toHaveLength(2);
  expect(rounds[1]).toMatchObject({
    lines: [],
    includeTableCart: {
      expectedCartVersion: 5,
      lines: [
        { cartItemReference: id(81), decision: "Send" },
        { cartItemReference: id(84), decision: "Send" },
      ],
    },
  });
});

/**
 * v15 staff-round-speed: the order on this tablet was started while party id(41) sat at T4; that
 * party left, the table was cleaned and a new party (id(42)) sat down before staff pressed Send.
 */
async function partyLeftBeforeSend(page: Page, zh: boolean) {
  if (zh)
    await page.addInitScript(() => {
      window.localStorage.setItem("bop.merchant.language", "zh-Hans");
    });
  let party = id(41);
  await signIn(page);
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        items: [{ ...table, currentDiningSessionReference: party }],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  const rounds: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    rounds.push(body);
    if (body.expectedDiningSessionReference !== party)
      return route.fulfill({ status: 409, headers, json: { error: "table_party_changed" } });
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "8",
        orderVersion: 1,
        tableLabel: "T4",
        orderMinor: "791",
        tipMinor: "0",
        totalMinor: "791",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    });
  });
  await page.goto("/operations/order-entry?table=" + tableReference);
  await page.getByRole("button", { name: zh ? "添加Gyoza" : "Add Gyoza" }).click();
  party = id(42);
  await page.getByRole("button", { name: zh ? "发送订单" : "Send order" }).click();
  return rounds;
}

test("@production v15 staff-round-speed: an order left on the tablet after its party left is not sent to the next party unasked", async ({
  page,
}) => {
  const rounds = await partyLeftBeforeSend(page, false);
  await expect(page.getByRole("alert")).toHaveText(
    "The guests this order was taken for have left Table T4, and the table has been cleared or seated again. Nothing was sent or charged. Check the order with the guests at the table now before sending it for them, or start over.",
  );
  expect(rounds).toHaveLength(1);
  expect(rounds[0]?.expectedDiningSessionReference).toBe(id(41));
  await expectNoInternalText(page);
  // Staff checked the order with the guests seated now: sent for them, as a new request.
  await page.getByRole("button", { name: "Send it for the guests at the table now" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $7.91 on the card machine" }),
  ).toBeVisible();
  expect(rounds).toHaveLength(2);
  expect(rounds[1]?.expectedDiningSessionReference).toBe(id(42));
  expect(rounds[1]?.operationReference).not.toBe(rounds[0]?.operationReference);
});

test("@production v15 staff-round-speed: the left-party refusal and its choices read in Chinese at 1440, 1024 and 390", async ({
  page,
}) => {
  await partyLeftBeforeSend(page, true);
  await expect(page.getByRole("alert")).toHaveText(
    "这张单点菜时的那桌客人已经离开桌台 T4，这张桌台已清台或换了一桌客人。这张单没有发送，也没有收款。请先和现在这桌客人核对这张单，再替他们发送；或者重新点单。",
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("button", { name: "替现在这桌客人发送" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新点单" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    ).toBe(false);
  }
  await expectNoInternalText(page);
  // Start over: the old order is cleared; nothing was sent.
  await page.getByRole("button", { name: "重新点单" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
