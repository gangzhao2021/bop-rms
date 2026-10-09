import { expect, test } from "@playwright/test";

test("@production serving retains its intent after a lost response and locks refresh", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
              },
            ],
            canRequestAcceptance: false,
            currentPhase: "Accepted",
            currentVersion: 2,
            unfulfillable: null,
            pickupNotCollected: false,
          },
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
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
        currentOrderVersion: 4,
        tableLabel: "T1",
        phase: committed ? "Fulfilled" : "Ready",
        observedAt: "2026-09-14T00:01:00.000Z",
        items: [
          {
            orderItemReference: id(3),
            orderBatchReference: id(90),
            displayName: "Meal",
            batchSequence: 1,
            itemOrdinal: 1,
            phase: committed ? "Fulfilled" : "Ready",
            orderedQuantity: 2,
            deliveredQuantity: committed ? 2 : 0,
            remainingQuantity: committed ? 0 : 2,
            itemServiceVersion: committed ? 1 : 0,
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/dining/serve", async (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    bodies.push(route.request().postData() ?? "");
    if (bodies.length === 1) return route.abort("failed");
    committed = true;
    return route.fulfill({ headers, json: { status: "AlreadyCommitted", itemServiceVersion: 1 } });
  });
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "View serving progress", exact: true }).click();
  const submit = page.getByRole("button", { name: "Confirm served quantity", exact: true });
  await expect(submit).toBeDisabled();
  const quantity = page.getByRole("spinbutton");
  await quantity.fill("2");
  await page
    .getByRole("checkbox", { name: "I confirm 2 × Meal delivered to table T1", exact: true })
    .check();
  await submit.click();
  const retry = page.getByRole("button", { name: "Retry same serving request", exact: true });
  await expect(retry).toBeEnabled();
  await expect(quantity).toBeDisabled();
  await expect(page.getByRole("button", { name: "Refresh orders", exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Refresh serving progress", exact: true }),
  ).toBeDisabled();
  await retry.click();
  await expect(
    page.getByText("Fulfilled · Ordered 2 · Served 2 · Remaining 0", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh orders", exact: true })).toBeEnabled();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
    quantity: 2,
    expectedItemServiceVersion: 0,
    expectedSessionVersion: 2,
    expectedTableAssignmentVersion: 3,
  });
});
