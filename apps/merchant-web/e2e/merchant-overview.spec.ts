import { expect, test } from "@playwright/test";

test("@production Merchant Overview uses the authorized workspace snapshot at desktop and mobile widths", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const primary = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
  };
  const secondary = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Second Store",
    storeReference: id(98),
  };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: primary,
          authorizedStores: [primary, secondary],
          businessDate: "2026-09-23",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "HOME-OVERVIEW",
              label: "Overview",
              href: "/app",
              permission: "merchant.access",
            },
            {
              screenId: "OPS-ORDER-QUEUE",
              label: "Orders",
              href: "/operations/orders",
              permission: "ordering.operate",
            },
            {
              screenId: "FUL-PICKUP-QUEUE",
              label: "Pickup",
              href: "/operations/pickup",
              permission: "fulfillment.operate",
            },
            {
              screenId: "OPS-ORDER-EXCEPTION",
              label: "Exceptions",
              href: "/operations/order-exceptions",
              permission: "operations.order-exception.manage",
            },
          ],
        },
      },
    }),
  );

  const headers = { "cache-control": "no-store" };
  const order = (n: number, phase: "Submitted" | "Accepted" | "Ready", version: number) => ({
    orderReference: id(n),
    orderNumber: "ORD-" + n,
    orderType: "Pickup",
    sourceChannel: "Web",
    submittedAt: "2026-09-23T14:00:00.000Z",
    observedAt: "2026-09-23T14:01:00.000Z",
    initialBatchReference: id(50 + n),
    batches: [
      {
        orderBatchReference: id(50 + n),
        sequence: 1,
        acceptanceStatus: phase === "Submitted" ? "NotAccepted" : "Accepted",
        canRequestAcceptance: phase === "Submitted",
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: phase === "Submitted",
    currentPhase: phase,
    currentVersion: version,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({
      headers,
      json: {
        // Newest first, as the queue contract requires.
        items: [order(3, "Ready", 3), order(2, "Submitted", 1), order(1, "Accepted", 2)],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.route("**/merchant/pickup/query", (route) =>
    route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: primary.storeReference,
        observedAt: "2026-09-23T14:01:00.000Z",
        nextAfterFulfillmentReference: null,
        items: [
          {
            fulfillmentReference: id(20),
            orderReference: id(1),
            phase: "Ready",
            aggregateVersion: "3",
            readyAt: "2026-09-23T13:50:00.000Z",
            publicOrderReference: "A".repeat(22),
            proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-09-23T15:00:00.000Z" },
            items: [
              {
                fulfillmentItemReference: id(21),
                orderedQuantity: 1,
                readyQuantity: 1,
                handedOverQuantity: 0,
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-EXCEPTION",
        projectionName: "merchant_order_exception_v1",
        storeLabel: primary.storeLabel,
        businessDate: "2026-09-23",
        projectedAt: "2026-09-23T14:01:00.000Z",
        freshnessStatus: "Fresh",
        items: [
          {
            exceptionReference: id(30),
            orderReference: id(3),
            orderNumber: "ORD-3",
            kind: "PaymentReconciliationDifference",
            severity: "High",
            status: "Open",
            providerState: "Unknown",
            compensationStatus: "Pending",
            sourceOwner: "Payment",
            createdAt: "2026-09-23T13:00:00.000Z",
            dueAt: "2026-09-23T13:30:00.000Z",
            ownerStatus: "Unassigned",
            sourceFinal: false,
          },
        ],
      },
    }),
  );

  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Training Store" })).toBeVisible();
  const workspace = page.getByRole("navigation", { name: "Workspace" });
  await expect(workspace.getByRole("link", { name: "Home" }).first()).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(workspace.getByRole("link", { name: "Orders" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Kitchen" })).toHaveCount(0);
  await expect(page.getByText("Open", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Authorized Store" })).toHaveValue(id(99));
  await expect(page.getByText("WP-1905")).toHaveCount(0);
  await expect(page.getByText("not available in this release", { exact: false })).toHaveCount(0);
  // WP-2423 P2: the "right now" card reads the pilot projections and links to each page.
  const now = page.getByRole("region", { name: "Right now" });
  await expect(now.getByText("1 awaiting acceptance · 1 ready")).toBeVisible();
  await expect(now.getByText("Ready for collection")).toBeVisible();
  await expect(now.getByText("1 overdue")).toBeVisible();
  await expect(now.getByText(/^Updated · \d\d:\d\d/u)).toBeVisible();
  await expect(now.getByRole("link", { name: "View exceptions" })).toHaveAttribute(
    "href",
    "/operations/order-exceptions",
  );

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".workspace-page__freshness")).toHaveText("Updated");
    await expect(page.locator(".workspace-page__freshness")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/home-overview-${width}.png` });
  }
});

test("@production Home reads only the summaries the staff member's screens permit (WP-2423 Q11 follow-up)", async ({
  page,
}) => {
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference: "01909968-0000-7000-8000-000000000099",
  };
  const navigation = (screens: readonly [string, string, string, string][]) =>
    screens.map(([screenId, label, href, permission]) => ({ screenId, label, href, permission }));
  let screens = navigation([
    ["HOME-OVERVIEW", "Overview", "/app", "merchant.access"],
    ["OPS-ORDER-ENTRY", "Counter order", "/operations/order-entry", "ordering.order.create_staff"],
    ["DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"],
  ]);
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-09-23",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: screens,
        },
      },
    }),
  );
  // WP-2423 Q18: the staff Session activity report (not a summary read).
  await page.route("**/merchant/session/activity", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
        idleTimeoutMinutes: 30,
        serverTime: new Date().toISOString(),
      },
    }),
  );
  // WP-2423 Q21: the Store's current business day (read by every Store workspace page).
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        businessDate: "2026-09-23",
        startsAt: "2026-09-23T08:00:00.000Z",
        endsAt: "2026-09-24T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: "2026-09-23T16:00:00.000Z",
      },
    }),
  );
  const requested: string[] = [];
  for (const path of [
    "**/merchant/orders*",
    "**/merchant/pickup/query",
    "**/merchant/order-exceptions",
  ])
    await page.route(path, (route) => {
      requested.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 403, json: { error: "request_denied" } });
    });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  // A cashier: no order queue, pickup or exception screen — Home reads none of them.
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Training Store" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(requested).toEqual([]);
  expect(errors).toEqual([]);
  await expect(page.getByRole("region", { name: "Right now" })).toHaveCount(0);

  // With the order queue screen only, Home reads the orders summary and nothing else.
  screens = navigation([
    ["HOME-OVERVIEW", "Overview", "/app", "merchant.access"],
    ["OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"],
  ]);
  await page.reload();
  await expect(page.getByRole("region", { name: "Right now" })).toBeVisible();
  await expect(page.getByText("Open orders")).toBeVisible();
  await expect(page.getByText("Pickups waiting")).toHaveCount(0);
  await expect(page.getByText("Open exceptions")).toHaveCount(0);
  expect(new Set(requested)).toEqual(new Set(["/merchant/orders"]));
});
