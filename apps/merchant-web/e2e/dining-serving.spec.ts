import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

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
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
              },
            ],
            canRequestAcceptance: false,
            currentPhase: committed ? "Fulfilled" : "Ready",
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
  // Orders v3 (Owner 2026-10-26): serving progress is under the round, read with the order — no
  // switch to open it — and serving is one tap, with no quantity box or confirmation (not money).
  await expect(page.getByRole("button", { name: "View serving progress" })).toHaveCount(0);
  const round = page.getByRole("region", { name: "Round 1", exact: true });
  await expect(round.getByText("Served 0/2")).toBeVisible();
  await expect(round.getByText("Ready to serve", { exact: true })).toBeVisible();
  await expect(round.getByRole("checkbox")).toHaveCount(0);
  await expect(round.getByRole("spinbutton")).toHaveCount(0);
  // Everything still to serve, in one tap.
  const served = round.getByRole("button", { name: "Mark 2 × Meal served", exact: true });
  await served.click();
  // The answer was lost: the same button offers the same request again; nothing else moves.
  await expect(served).toHaveText("Try again");
  await expect(served).toBeEnabled();
  await served.click();
  await expect(round.getByText("Served 2/2")).toBeVisible();
  await expect(served).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh orders", exact: true })).toBeEnabled();
  // WP-2423: the order's status is reread as soon as the item is served (before the 10 s poll).
  await expect(page.locator(".order-workbench-phase")).toHaveText("Served", { timeout: 5_000 });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
    quantity: 2,
    expectedItemServiceVersion: 0,
    expectedSessionVersion: 2,
    expectedTableAssignmentVersion: 3,
  });
});

test("@production WP-2423 (2026-10-18): a dish the kitchen is remaking says so and is not offered for serving", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
  const line = (n: number, displayName: string, remakingQuantity: number) => ({
    orderItemReference: id(n),
    orderBatchReference: id(90),
    displayName,
    batchSequence: 1,
    itemOrdinal: n - 2,
    phase: "Ready",
    orderedQuantity: 1,
    deliveredQuantity: 0,
    remainingQuantity: 1,
    itemServiceVersion: 0,
    remakingQuantity,
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
        currentOrderVersion: 4,
        tableLabel: "T1",
        phase: "Ready",
        observedAt: "2026-09-14T00:01:00.000Z",
        items: [line(3, "Beef noodle soup", 1), line(4, "Green tea", 0)],
      },
    }),
  );
  await page.goto("/operations/orders");
  // Orders v3: the round lists its dishes and serving state without a switch to open.
  const progress = page.getByRole("region", { name: "Round 1", exact: true });
  const soup = progress.getByRole("listitem").filter({ hasText: "Beef noodle soup" });
  await expect(soup.getByText("Being remade")).toBeVisible();
  await expect(
    soup.getByText("Remaking — don't serve it until the kitchen marks the remake done."),
  ).toBeVisible();
  // Only the tea can be served; the soup has no serving control.
  await expect(soup.getByRole("button")).toHaveCount(0);
  await expect(
    progress.getByRole("listitem").filter({ hasText: "Green tea" }).getByRole("button"),
  ).toHaveCount(1);
  await expect(progress).not.toContainText("NOT_READY");
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const remaking = soup.getByText("Being remade");
    await remaking.scrollIntoViewIfNeeded();
    await expect(remaking).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/dining-serving-remaking-${width}.png`,
      fullPage: true,
    });
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
});
