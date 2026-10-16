import { expect, test } from "@playwright/test";

test("@production serve all ready items of a round with one confirmation, retrying a lost answer", async ({
  page,
}) => {
  const id = (n: number) => "01909968-3333-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
  };
  const headers = { "cache-control": "no-store" };
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
          businessDate: "2026-09-14",
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
          ],
        },
      },
    }),
  );

  // Three lines of round 1 are ready. Meanwhile another device cancels "Soup", so after the
  // batch two are served and one changed.
  let committed = false;
  const bodies: string[] = [];
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
            submittedAt: "2026-09-14T00:00:00.000Z",
            observedAt: "2026-09-14T00:01:00.000Z",
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
            currentPhase: "Ready",
            currentVersion: 2,
            unfulfillable: null,
            pickupNotCollected: false,
            acceptBy: null,
            awaitingPayment: false,
          },
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  const line = (n: number, name: string, served: boolean, cancelled = false) => ({
    orderItemReference: id(n),
    orderBatchReference: id(90),
    displayName: name,
    batchSequence: 1,
    itemOrdinal: n,
    phase: cancelled ? "Cancelled" : served ? "Fulfilled" : "Ready",
    orderedQuantity: 2,
    deliveredQuantity: served ? 2 : 0,
    remainingQuantity: served ? 0 : 2,
    itemServiceVersion: served ? 1 : 0,
  });
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        orderVersion: 2,
        sessionVersion: 2,
        diningSessionReference: id(55),
        sessionPhase: "Active",
        tableAssignmentVersion: 3,
        closureStatus: "Open",
        closureVersion: 0,
        currentOrderVersion: committed ? 3 : 2,
        tableLabel: "T1",
        phase: "Ready",
        observedAt: committed ? "2026-09-14T00:02:00.000Z" : "2026-09-14T00:01:00.000Z",
        items: [
          line(3, "Meal", committed),
          line(4, "Salad", committed),
          line(5, "Soup", false, committed),
        ],
      },
    }),
  );
  await page.route("**/merchant/dining/serve-ready", async (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    bodies.push(route.request().postData() ?? "");
    if (bodies.length === 1) return route.abort("failed");
    committed = true;
    const body = JSON.parse(bodies[0] ?? "{}") as { operationReference: string };
    return route.fulfill({
      headers,
      json: {
        operationReference: body.operationReference,
        served: 2,
        alreadyServed: 0,
        changed: 1,
        failed: 0,
        lines: [
          { orderItemReference: id(3), outcome: "Served" },
          { orderItemReference: id(4), outcome: "Served" },
          { orderItemReference: id(5), outcome: "Changed" },
        ],
      },
    });
  });
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "View serving progress", exact: true }).click();
  await page
    .getByRole("button", { name: "Serve all 3 ready items in round 1", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Mark 3 items served for round 1 at table T1?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("2 × Soup", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Mark 3 items served", exact: true }).click();
  const retry = dialog.getByRole("button", { name: "Retry the same request", exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.getByRole("button", { name: "Refresh orders", exact: true })).toBeDisabled();
  await retry.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText(
      "2 served. 1 could not be served because it changed (cancelled, partly served or the table moved). Check it and try again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Fulfilled · Ordered 2 · Served 2 · Remaining 0", { exact: true }),
  ).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Serve all .* ready items/u })).toHaveCount(0);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
    orderReference: id(1),
    expectedOrderVersion: 2,
    expectedSessionVersion: 2,
    expectedTableAssignmentVersion: 3,
    lines: [
      { orderItemReference: id(3), quantity: 2, expectedItemServiceVersion: 0 },
      { orderItemReference: id(4), quantity: 2, expectedItemServiceVersion: 0 },
      { orderItemReference: id(5), quantity: 2, expectedItemServiceVersion: 0 },
    ],
  });
});
