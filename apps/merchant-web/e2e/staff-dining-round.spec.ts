import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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
      /Record the payment by .+ The kitchen starts this order once it is recorded here\./u,
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
  expect(accepted).toEqual([
    expect.objectContaining({
      orderReference: id(20),
      orderBatchReference: id(21),
      expectedOrderVersion: 4,
    }),
  ]);
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
  const listed = () => ({
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
          batch(3, {
            acceptanceStatus: "NotAccepted",
            paymentDue: { status: "Awaiting", cancelsAt: null },
            staffRound: { recordedAfterOutage: false, paidOnCardMachine: null },
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
  await page.goto("/operations/orders");
  const entry = page.locator("details.order-workbench-entry").first();
  await expect(entry).toContainText("Batch 3: Entered by staff · awaiting card-machine payment");
  if (!(await entry.evaluate((element) => (element as HTMLDetailsElement).open)))
    await entry.locator("summary").click();
  await expect(
    entry.getByRole("heading", { name: "Batch 2 · Additional · Entered by staff" }),
  ).toBeVisible();
  await expect(entry.getByText(/Paid on card machine \$23\.04/u)).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await expect(page.getByText(/cancelled automatically/u)).toHaveCount(0);
  await expectNoInternalText(page);
});
