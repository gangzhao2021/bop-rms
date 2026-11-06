import { expect, test, type Page } from "@playwright/test";

/**
 * WP-2423 item 10: when the server answers 5xx, the floor screens say what to do and never blame the
 * restaurant's wifi or the person's permissions; a 409 reads the table again; and money or a save
 * that may have gone through goes again as the same operation, so it is recorded once.
 */
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
};
const words =
  "Our system has a problem; your wifi is fine. Keep serving: paper slips for new rounds, card machine for payment. This screen keeps trying.";
const kitchenWords =
  "Our system has a problem; your wifi is fine. Cook from the paper slips the floor brings. This screen keeps trying.";
const pickupWords =
  "Our system has a problem; your wifi is fine. Hand over by checking the order number and items on the guest's phone or slip. This screen keeps trying.";
const retryLater = { status: 503, headers, json: { error: "retry_later" } };
const pickupQueue = {
  source: "CurrentFulfillment",
  workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
  storeReference: scope.storeReference,
  observedAt: "2026-11-05T16:00:00.000Z",
  nextAfterFulfillmentReference: null,
  items: [],
};

async function session(
  page: Page,
  navigation: readonly { screenId: string; label: string; href: string; permission: string }[],
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
          businessDate: "2026-11-05",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation,
        },
      },
    }),
  );
}
const tablesNavigation = [
  {
    screenId: "DIN-FLOOR-BOARD",
    label: "Tables",
    href: "/operations/dining",
    permission: "dining.operate",
  },
];
const ordersNavigation = [
  {
    screenId: "OPS-ORDER-QUEUE",
    label: "Orders",
    href: "/operations/orders",
    permission: "ordering.operate",
  },
];
const kitchenNavigation = [
  {
    screenId: "KIT-KITCHEN-QUEUE",
    label: "Kitchen",
    href: "/operations/kitchen",
    permission: "kitchen.operate",
  },
];

/** Neither the router nor the person's role is what staff should go and look at. */
async function expectNoBlame(page: Page) {
  const text = (await page.locator("body").innerText()).toLowerCase();
  expect(text).not.toContain("connection");
  expect(text).not.toContain("permission");
}

const freeTable = {
  tableReference: id(1),
  stableLabel: "T1",
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  aggregateVersion: 2,
  currentDiningSessionReference: null,
  elapsedMinutes: null,
  qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
};
const tablesAnswer = {
  items: [freeTable],
  nextAfterTableReference: null,
  canOperateTables: true,
};

test("@production Tables says what to do when the server fails, and comes back by itself", async ({
  page,
}) => {
  await session(page, tablesNavigation);
  let down = true;
  await page.route("**/merchant/dining/tables", (route) =>
    down ? route.fulfill(retryLater) : route.fulfill({ headers, json: tablesAnswer }),
  );
  await page.goto("/operations/dining");
  await expect(page.getByText(words)).toBeVisible();
  // The outage guide stays on the screen they are working in.
  await expect(page.getByRole("note", { name: "While Tables isn't working" })).toContainText(
    "Take new rounds on paper slips",
  );
  await expectNoBlame(page);
  down = false;
  const select = page.getByRole("button", { name: "Select T1", exact: true });
  await expect(select).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText(words)).toHaveCount(0);
  await expect(page.getByRole("note", { name: "While Tables isn't working" })).toHaveCount(0);
});

test("@production a re-read of Tables the server failed keeps the list read-only and says why", async ({
  page,
}) => {
  await session(page, tablesNavigation);
  let down = false;
  await page.route("**/merchant/dining/tables", (route) =>
    down ? route.fulfill(retryLater) : route.fulfill({ headers, json: tablesAnswer }),
  );
  await page.goto("/operations/dining");
  const select = page.getByRole("button", { name: "Select T1", exact: true });
  await expect(select).toBeEnabled();
  down = true;
  await page.getByRole("button", { name: "Refresh tables", exact: true }).click();
  await expect(page.getByText(words)).toBeVisible();
  await expect(page.getByRole("note", { name: "While Tables isn't working" })).toBeVisible();
  await expect(select).toBeDisabled();
  await expectNoBlame(page);
});

test("@production two servers open one table: the second is told, and the table is read again", async ({
  page,
}) => {
  await session(page, tablesNavigation);
  let reads = 0;
  await page.route("**/merchant/dining/tables", (route) => {
    reads += 1;
    return route.fulfill({ headers, json: tablesAnswer });
  });
  const starts: string[] = [];
  await page.route("**/merchant/dining/sessions/start", (route) => {
    starts.push(
      String((route.request().postDataJSON() as { operationReference: string }).operationReference),
    );
    return route.fulfill({ status: 409, headers, json: { error: "changed_while_loading" } });
  });
  await page.goto("/operations/dining");
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toBeVisible();
  const before = reads;
  await page.getByRole("button", { name: "Open table", exact: true }).click();
  await expect(page.getByText("This table changed. It has been read again.")).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expectNoBlame(page);
  expect(starts).toHaveLength(1);
});

test("@production a table action the server failed goes again as the same request", async ({
  page,
}) => {
  await session(page, tablesNavigation);
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({ headers, json: tablesAnswer }),
  );
  const starts: string[] = [];
  await page.route("**/merchant/dining/sessions/start", (route) => {
    starts.push(
      String((route.request().postDataJSON() as { operationReference: string }).operationReference),
    );
    return route.fulfill(retryLater);
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Open table", exact: true }).click();
  await expect(
    page.getByText("We couldn't confirm the result. Press again: it is never recorded twice.", {
      exact: false,
    }),
  ).toBeVisible();
  await expectNoBlame(page);
  await page
    .getByLabel("Open this table")
    .getByRole("button", { name: "Try opening again", exact: true })
    .click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]).toBe(starts[0]);
});

test("@production Orders says what to do when the server fails, and comes back by itself", async ({
  page,
}) => {
  await session(page, ordersNavigation);
  let down = true;
  await page.route("**/merchant/orders", (route) =>
    down
      ? route.fulfill(retryLater)
      : route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  await page.goto("/operations/orders");
  await expect(page.getByText(words)).toBeVisible();
  await expectNoBlame(page);
  down = false;
  await expect(page.getByText(words)).toHaveCount(0, { timeout: 15_000 });
});

test("@production the Kitchen board says what to do when the server fails", async ({ page }) => {
  await session(page, kitchenNavigation);
  await page.route("**/merchant/kitchen/query", (route) => route.fulfill(retryLater));
  await page.goto("/operations/kitchen");
  await expect(page.getByText(kitchenWords)).toBeVisible();
  await expect(page.getByText(words)).toHaveCount(0);
  await expectNoBlame(page);
});

test("@production Pickup says what to do when the server fails, and comes back by itself", async ({
  page,
}) => {
  await session(page, [
    {
      screenId: "FUL-PICKUP-QUEUE",
      label: "Pickup",
      href: "/operations/pickup",
      permission: "fulfillment.operate",
    },
  ]);
  let down = true;
  await page.route("**/merchant/pickup/query", (route) =>
    down ? route.fulfill(retryLater) : route.fulfill({ headers, json: pickupQueue }),
  );
  await page.goto("/operations/pickup");
  await expect(page.getByText(pickupWords)).toBeVisible();
  await expect(page.getByText(words)).toHaveCount(0);
  await expectNoBlame(page);
  // Nobody presses Refresh: the queue comes back on its own once the server does.
  down = false;
  await expect(page.getByText(pickupWords)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("No pickups waiting")).toBeVisible();
});

test("@production Home says what to do when the server fails on what it reads", async ({
  page,
}) => {
  await session(page, [...ordersNavigation, ...tablesNavigation]);
  await page.route("**/merchant/orders", (route) => route.fulfill(retryLater));
  await page.route("**/merchant/dining/tables", (route) => route.fulfill(retryLater));
  await page.goto("/app");
  await expect(page.getByText("This list may be missing something")).toBeVisible();
  await expect(page.getByText(words, { exact: false })).toBeVisible();
  await expectNoBlame(page);
});

const cashPayment = {
  partNumber: null,
  method: "Cash",
  roundsMinor: "4000",
  tipMinor: "0",
  roundingMinor: "0",
  totalMinor: "4000",
  takenAt: "2026-11-05T20:00:00.000Z",
  recordedAfterOutage: false,
  cashRefunds: [],
  cardRefunds: [],
  onlineRefunds: [],
  refundableMinor: "4000",
};
async function orderWithCashPayment(page: Page) {
  await session(page, ordersNavigation);
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          {
            orderReference: id(1),
            orderNumber: "ORD-1",
            orderType: "DineIn",
            sourceChannel: "Web",
            submittedAt: "2026-11-05T19:00:00.000Z",
            observedAt: "2026-11-05T20:20:00.000Z",
            initialBatchReference: id(90),
            batches: [
              {
                orderBatchReference: id(90),
                sequence: 1,
                acceptanceStatus: "Accepted",
                canRequestAcceptance: false,
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
              },
            ],
            canRequestAcceptance: false,
            currentPhase: "Accepted",
            currentVersion: 2,
            unfulfillable: null,
            pickupNotCollected: false,
            acceptBy: null,
            awaitingPayment: false,
            canRecordCardMachinePayment: false,
            canViewPayments: true,
            tableBill: {
              totalMinor: "4000",
              paid: { amountMinor: "4000", method: "Cash" },
            },
          },
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.route("**/merchant/orders/table-payment", (route) =>
    route.fulfill({ headers, json: { orderReference: id(1), payment: cashPayment, parts: [] } }),
  );
}

test("@production cash back the server failed on goes again as the same request, so it is given once", async ({
  page,
}) => {
  await orderWithCashPayment(page);
  const bodies: { operationReference: string }[] = [];
  let failing = true;
  await page.route("**/merchant/orders/table-payment/cash-refund", (route) => {
    bodies.push(route.request().postDataJSON() as { operationReference: string });
    if (failing) return route.fulfill(retryLater);
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(1),
        payment: { ...cashPayment, refundableMinor: "3000" },
        parts: [],
      },
    });
  });
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "Give cash back", exact: true }).click();
  await page.getByLabel("Amount to give back").fill("10");
  await page.getByRole("combobox", { name: /Reason/u }).selectOption("FOOD_ISSUE");
  await page.getByRole("button", { name: /10\.00 in cash$/u }).click();
  const confirm = page.getByRole("button", { name: /^Confirm: give back/u });
  await confirm.click();
  await expect(
    page.getByText("We couldn't confirm the result. Press again: it is never recorded twice."),
  ).toBeVisible();
  await expect(page.getByText("wasn't recorded", { exact: false })).toHaveCount(0);
  failing = false;
  await confirm.click();
  await expect(page.getByText(/Give it to the guest now/u)).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.operationReference).toBe(bodies[0]?.operationReference);
});

test("@production a refused cash refund still says who may do it, and starts over", async ({
  page,
}) => {
  await orderWithCashPayment(page);
  await page.route("**/merchant/orders/table-payment/cash-refund", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "request_denied" } }),
  );
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "Give cash back", exact: true }).click();
  await page.getByLabel("Amount to give back").fill("10");
  await page.getByRole("combobox", { name: /Reason/u }).selectOption("FOOD_ISSUE");
  await page.getByRole("button", { name: /10\.00 in cash$/u }).click();
  await page.getByRole("button", { name: /^Confirm: give back/u }).click();
  await expect(page.getByText(/A manager gives cash back/u)).toBeVisible();
});

const backOfficePages = [
  ["CAT-PRODUCT-LIST", "/app/commerce/products", "catalog.manage"],
  ["RECIPE-LIST", "/app/commerce/recipes", "recipe.read"],
  ["CMP-ALLERGEN-REVIEW", "/app/compliance/allergens", "catalog.allergen.read"],
  ["PRICE-BOOK-LIST", "/app/commerce/pricing", "pricing.price_book.read"],
  ["PRICE-OPTION-LIST", "/app/commerce/option-prices", "pricing.price_book.read"],
  ["CAT-OPTIONSET-LIST", "/app/commerce/option-sets", "catalog.option_set.read"],
  ["RECIPE-OPTION-LIST", "/app/commerce/option-recipes", "recipe.read"],
  ["CAT-AVAILABILITY", "/app/commerce/availability", "catalog.sku.read"],
  ["INV-ITEM-LIST", "/app/supply/items", "inventory.item.read"],
  ["INV-LOCATION-LIST", "/app/supply/locations", "inventory.location.read"],
  ["INV-RECEIPT-LIST", "/operations/receiving", "inventory.receipt.read"],
  ["INV-WASTE-RECORD", "/operations/inventory/waste", "inventory.waste.record"],
  ["INV-OPENING-COUNT", "/app/supply/opening-count", "inventory.count.read"],
  ["TAX-STORE-REVIEW", "/app/commerce/tax-review", "pricing.tax_config.read"],
  ["IAM-USER-LIST", "/app/organization/users", "organization.staff.read"],
  ["IAM-ROLE-LIST", "/app/organization/roles", "identity.role.read"],
  ["CAT-MENU-LIST", "/app/commerce/menus", "catalog.menu.read"],
] as const;

for (const [screenId, href, permission] of backOfficePages)
  test(`@production ${screenId} says it didn't load, and reads again when asked`, async ({
    page,
  }) => {
    const reads: string[] = [];
    await page.route("**/merchant/**", (route) => {
      reads.push(new URL(route.request().url()).pathname);
      return route.fulfill(retryLater);
    });
    await session(page, [{ screenId, label: "Page", href, permission }]);
    await page.goto(href);
    await expect(page.getByRole("heading", { name: "This page didn't load" })).toBeVisible();
    await expect(page.getByText("Nothing you saved is affected.", { exact: false })).toBeVisible();
    await expectNoBlame(page);
    const before = reads.length;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => reads.length).toBeGreaterThan(before);
    await expect(page.getByRole("heading", { name: "This page didn't load" })).toBeVisible();
  });

test("@production a back office page opens once a try works", async ({ page }) => {
  let down = true;
  await page.route("**/merchant/commerce/products/query", (route) =>
    down
      ? route.fulfill(retryLater)
      : route.fulfill({
          headers,
          json: {
            screenId: "CAT-PRODUCT-LIST",
            sourceAsOf: "2026-11-05T20:00:00.000Z",
            permissions: {},
            taxClasses: [],
            productTypes: [],
            products: [],
          },
        }),
  );
  await session(page, [
    {
      screenId: "CAT-PRODUCT-LIST",
      label: "Products",
      href: "/app/commerce/products",
      permission: "catalog.manage",
    },
  ]);
  await page.goto("/app/commerce/products");
  await expect(page.getByRole("heading", { name: "This page didn't load" })).toBeVisible();
  down = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No products yet" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This page didn't load" })).toHaveCount(0);
});
