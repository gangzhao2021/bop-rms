import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

test("@production a server chases a dish still being made; a round waits 5 minutes between chases", async ({
  page,
}) => {
  const id = (n: number) => "01a0f0d1-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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

  // WP-2423 item 8 ⑦ (Owner decision 4): the Store has chasing on; the noodles are being made.
  let chases = 0;
  const chaseCalls: Record<string, string>[] = [];
  let tooSoon = false;
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          {
            orderReference: id(1),
            orderNumber: "ORD-12",
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
            currentPhase: "InProgress",
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
        phase: "InProgress",
        observedAt: "2026-09-14T00:01:00.000Z",
        chaseDish: true,
        items: [
          {
            orderItemReference: id(3),
            orderBatchReference: id(90),
            displayName: "Dan dan noodles (TEST)",
            batchSequence: 1,
            itemOrdinal: 1,
            phase: "InProgress",
            orderedQuantity: 1,
            deliveredQuantity: 0,
            remainingQuantity: 1,
            itemServiceVersion: 0,
            ...(chases === 0
              ? {}
              : { chase: { count: chases, lastChasedAt: "2026-09-14T00:05:00.000Z" } }),
          },
          {
            orderItemReference: id(4),
            orderBatchReference: id(90),
            displayName: "Green tea (TEST)",
            batchSequence: 1,
            itemOrdinal: 2,
            phase: "Ready",
            orderedQuantity: 1,
            deliveredQuantity: 0,
            remainingQuantity: 1,
            itemServiceVersion: 0,
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/dining/chase", (route) => {
    chaseCalls.push(route.request().postDataJSON() as Record<string, string>);
    if (tooSoon)
      return route.fulfill({
        headers: { ...headers, "retry-after": "240" },
        status: 429,
        json: { error: "dining_chase_too_soon", retryAt: "2026-09-14T00:10:00.000Z" },
      });
    chases++;
    tooSoon = true;
    return route.fulfill({ headers, json: { status: "Chased", chaseCount: chases } });
  });
  await page.goto("/operations/orders");
  const round = page.getByRole("region", { name: "Round 1", exact: true });
  const chase = round.getByRole("button", {
    name: "Chase Dan dan noodles (TEST) with the kitchen",
  });
  await expect(chase).toBeVisible();
  // A dish already made is served, not chased.
  await expect(
    round.getByRole("button", { name: "Chase Green tea (TEST) with the kitchen" }),
  ).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).include(".dining-round-item").analyze();
  expect(axe.violations).toEqual([]);
  await chase.click();
  await expect(
    page.getByText("The kitchen was told to hurry Dan dan noodles (TEST)."),
  ).toBeVisible();
  await expect(round.getByText(/Chased once/u)).toBeVisible();
  expect(chaseCalls[0]).toMatchObject({ orderItemReference: id(3) });
  // Again within 5 minutes: refused, saying when it may be chased again; nothing is recorded.
  await chase.click();
  await expect(
    page.getByText(/This round was chased a moment ago\. You can chase it again at/u),
  ).toBeVisible();
  expect(chases).toBe(1);
  expect(chaseCalls).toHaveLength(2);
  expect(chaseCalls[1]?.operationReference).not.toBe(chaseCalls[0]?.operationReference);
  await expectNoInternalText(page);
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});
