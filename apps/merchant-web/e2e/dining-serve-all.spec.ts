import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

test("@production serve all ready items of a round in one tap, retrying a lost answer", async ({
  page,
}) => {
  const id = (n: number) => "01909968-3333-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
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
  const line = (
    n: number,
    name: string,
    served: boolean,
    cancelled = false,
    details: {
      options: { name: string; quantity: number }[];
      customerNote: string | null;
    } = { options: [], customerNote: null },
  ) => ({
    ...details,
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
          line(5, "Soup", false, committed, {
            options: [{ name: "Bowl", quantity: 1 }],
            customerNote: "Cup 3",
          }),
          // v15 2026-10-16: identical drinks without a note are one line in the confirmation.
          line(6, "Flat White", committed, false, {
            options: [{ name: "Small (8 oz)", quantity: 1 }],
            customerNote: null,
          }),
          line(7, "Flat White", committed, false, {
            options: [{ name: "Small (8 oz)", quantity: 1 }],
            customerNote: null,
          }),
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
        served: 4,
        alreadyServed: 0,
        changed: 1,
        failed: 0,
        lines: [
          { orderItemReference: id(3), outcome: "Served" },
          { orderItemReference: id(4), outcome: "Served" },
          { orderItemReference: id(5), outcome: "Changed" },
          { orderItemReference: id(6), outcome: "Served" },
          { orderItemReference: id(7), outcome: "Served" },
        ],
      },
    });
  });
  await page.goto("/operations/orders");
  // Orders v3 (Owner 2026-10-26): each round lists its dishes with their options and note, read
  // with the order; "All served" marks the round's ready dishes in one tap, no confirmation.
  const round = page.getByRole("region", { name: "Round 1", exact: true });
  await expect(round.getByText("Note: Cup 3", { exact: true })).toBeVisible();
  await expect(round.getByText("Served 0/10")).toBeVisible();
  await expectNoInternalText(page);
  const all = round.getByRole("button", { name: "All served", exact: true });
  await all.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The answer was lost: the same button sends the same request again.
  await expect(all).toHaveCount(0);
  const again = round.getByRole("button", { name: "Try again", exact: true });
  await expect(again).toBeEnabled();
  await again.click();
  await expect(
    page.getByText(
      "4 served. 1 could not be served because it changed (cancelled, partly served or the table moved). Check it and try again.",
      { exact: true },
    ),
  ).toBeVisible();
  // The soup changed (cancelled): it leaves the count.
  await expect(round.getByText("Served 8/8")).toBeVisible();
  await expect(round.getByRole("button", { name: /All served|Serve the/u })).toHaveCount(0);
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
      { orderItemReference: id(6), quantity: 2, expectedItemServiceVersion: 0 },
      { orderItemReference: id(7), quantity: 2, expectedItemServiceVersion: 0 },
    ],
  });
});
