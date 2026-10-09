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
      },
    ],
    canRequestAcceptance: phase === "Submitted",
    currentPhase: phase,
    currentVersion: version,
    unfulfillable: null,
    pickupNotCollected: false,
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
