import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { settlementViewFixture } from "../src/settlement.fixtures";

test("@production Merchant Overview uses the authorized workspace snapshot at desktop and mobile widths", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const primary = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
  };
  // A configured Store carries its time zone, so "Last checked" is Store-local time.
  const selectedScope = { ...primary, timeZone: "America/Toronto" };
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
          selectedScope,
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
            {
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
            {
              screenId: "PAY-RECONCILIATION",
              label: "Settlement",
              href: "/app/operations/payment-reconciliation",
              permission: "operations.order-exception.manage",
            },
          ],
        },
      },
    }),
  );

  const headers = { "cache-control": "no-store" };
  const order = (
    n: number,
    phase: "Submitted" | "Accepted" | "Ready",
    version: number,
    orderType: "Pickup" | "DineIn" = "Pickup",
  ) => ({
    orderReference: id(n),
    orderNumber: "ORD-" + n,
    orderType,
    sourceChannel: orderType === "Pickup" ? "Web" : "Qr",
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
        // Newest first, as the queue contract requires. A pickup stays Accepted in Ordering while
        // Fulfillment holds it ready for collection; only dine-in food is "ready to serve".
        // WP-2423: the table's Order is not Ready as a whole (another round is still being made),
        // but one item waits at the pass: the server's count, as on the Tables page, is used.
        items: [
          // WP-2423 (3cd0f8dd M7): a table whose order is all served, still open.
          { ...order(4, "Accepted", 4, "DineIn"), currentPhase: "Fulfilled" },
          { ...order(3, "Accepted", 3, "DineIn"), readyToServeItemCount: 1 },
          order(2, "Submitted", 1),
          order(1, "Accepted", 2),
        ],
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
          // WP-2423 (3cd0f8dd L7): an order from an earlier business day, apart from today's.
          {
            fulfillmentReference: id(22),
            orderReference: id(5),
            phase: "Ready",
            aggregateVersion: "2",
            readyAt: "2026-09-21T13:50:00.000Z",
            businessDate: "2026-09-21",
            publicOrderReference: "B".repeat(22),
            proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-09-21T15:00:00.000Z" },
            items: [
              {
                fulfillmentItemReference: id(23),
                orderedQuantity: 1,
                readyQuantity: 1,
                handedOverQuantity: 0,
              },
            ],
          },
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

  // WP-2423 Q13: the store system card (Owner and Store Manager) with nothing wrong.
  await page.route("**/merchant/operations-alerts", (route) =>
    route.fulfill({
      headers,
      json: {
        monitor: "Reporting",
        observedAt: "2026-09-23T14:01:00.000Z",
        active: [],
        recentlyCleared: [],
        outbound: { email: false, webhooks: 0, heartbeat: false },
        lastSuccessfulBackupAt: "2026-09-23T08:30:00.000Z",
      },
    }),
  );

  // WP-2423 (3cd0f8dd M7): one table open with its order served, for a manager who closes tables.
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: true,
        canTransferHost: true,
        canCancelUnpaidRounds: true,
        nextAfterTableReference: null,
        items: [
          {
            tableReference: id(40),
            stableLabel: "T1",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 3,
            currentDiningSessionReference: id(41),
            elapsedMinutes: 55,
            qrCodeValidUntil: "2027-03-01T00:00:00.000Z",
            session: { phase: "Active", version: 2, orderReference: id(4) },
            guestRoundsAwaitingPayment: [],
            roundsAwaitingAcceptance: [],
            staffRoundsAwaitingPayment: [],
          },
        ],
      },
    }),
  );
  // WP-2423 (3cd0f8dd M6): the last closed day's settlement for the opening checklist.
  await page.route("**/merchant/settlement", (route) =>
    route.fulfill({ headers, json: settlementViewFixture() }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-09-23",
        startsAt: "2026-09-23T08:00:00.000Z",
        endsAt: "2026-09-24T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: "2026-09-23T14:01:00.000Z",
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
  await expect(now.getByText("1 awaiting acceptance · 1 ready to serve")).toBeVisible();
  await expect(now.getByText("Ready for collection")).toBeVisible();
  // L7: today's pickups apart from an earlier day's, with the way to check and close it.
  await expect(now.getByText("Pickups from earlier days")).toBeVisible();
  await expect(now.getByRole("link", { name: "Check and close" })).toHaveAttribute(
    "href",
    "/operations/pickup",
  );
  // M7: the served table shows as waiting to be closed.
  await expect(now.getByText("1 table served — close when the guests have left")).toBeVisible();
  // M6: the opening and closing checklist from the same reads and the last closed day's settlement.
  const checklist = page.getByRole("region", { name: "Opening and closing" });
  await expect(checklist.getByText("Settlement for Mon, Sep 21")).toBeVisible();
  await expect(checklist.getByText("1 payment to look at")).toBeVisible();
  await expect(checklist.getByRole("link", { name: "Go to Settlement" })).toHaveAttribute(
    "href",
    "/app/operations/payment-reconciliation",
  );
  await expectNoInternalText(page);
  await expect(now.getByText("1 overdue")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Store system" }).getByText("Everything is working."),
  ).toBeVisible();
  await expect(now.getByText(/^Last checked \d\d:\d\d/u)).toBeVisible();
  await expect(now.getByRole("link", { name: "View exceptions" })).toHaveAttribute(
    "href",
    "/operations/order-exceptions",
  );

  for (const width of [1440, 1024, 390, 320]) {
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
    timeZone: "America/Toronto",
  };
  const navigation = (screens: readonly [string, string, string, string][]) =>
    screens.map(([screenId, label, href, permission]) => ({ screenId, label, href, permission }));
  let screens = navigation([
    ["HOME-OVERVIEW", "Overview", "/app", "merchant.access"],
    ["OPS-ORDER-ENTRY", "Counter order", "/operations/order-entry", "ordering.order.create_staff"],
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
  // WP-2423 (design "A"): the footer's "My PIN" reads the signed-in member's PIN status.
  await page.route("**/merchant/staff-pin", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        pin: { state: "Set", changedAt: "2026-09-20T16:00:00.000Z", lockedUntil: null },
        signIn: "Account",
        verifiedUntil: null,
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
  // WP-2423: this member already has a name, so Home does not ask for one.
  await page.route("**/merchant/organization/staff/me", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: { name: "Recorded", displayName: "Ava" },
    }),
  );
  // WP-2423: the BFF tells a role without store system alerts so in an ordinary answer.
  await page.route("**/merchant/operations-alerts", (route) => {
    requested.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      headers: { "cache-control": "no-store" },
      json: { permitted: false },
    });
  });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  // A cashier: no order queue, pickup or exception screen — Home reads none of them. The store
  // system card asks once; the server answers "not permitted", so the card stays hidden and no
  // refused request shows in the console.
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Training Store" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(requested).toEqual(["/merchant/operations-alerts"]);
  expect(errors).toEqual([]);
  await expect(page.getByRole("region", { name: "Right now" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Store system" })).toHaveCount(0);
  await expect(page.getByText("System alerts could not be read")).toHaveCount(0);

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
  expect(new Set(requested)).toEqual(new Set(["/merchant/orders", "/merchant/operations-alerts"]));
  await expect(page.getByRole("region", { name: "Store system" })).toHaveCount(0);

  // WP-2423 (3cd0f8dd M7): a cashier with Tables sees the open tables and who closes them.
  await page.route("**/merchant/dining/tables", (route) => {
    requested.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        canOperateTables: true,
        canCloseSessions: false,
        nextAfterTableReference: null,
        items: [
          {
            tableReference: "01909968-0000-7000-8000-000000000040",
            stableLabel: "T1",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 3,
            currentDiningSessionReference: "01909968-0000-7000-8000-000000000041",
            elapsedMinutes: 55,
            qrCodeValidUntil: "2027-03-01T00:00:00.000Z",
            guestRoundsAwaitingPayment: [],
            roundsAwaitingAcceptance: [],
            staffRoundsAwaitingPayment: [],
          },
        ],
      },
    });
  });
  requested.length = 0;
  screens = navigation([
    ["HOME-OVERVIEW", "Overview", "/app", "merchant.access"],
    ["DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"],
  ]);
  await page.reload();
  const now = page.getByRole("region", { name: "Right now" });
  await expect(
    now.getByText("A manager or the owner closes tables when the guests have left"),
  ).toBeVisible();
  await expect(now.getByText("Open orders")).toHaveCount(0);
  expect(new Set(requested)).toEqual(
    new Set(["/merchant/dining/tables", "/merchant/operations-alerts"]),
  );
  await expectNoInternalText(page);
});
