import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// v15 batch-5 (shared-table-staff-round): a round staff entered for a table and not yet paid on
// the card machine reads "Waiting for card-machine payment" on each dish and on the round, never
// "Waiting for staff"; a paid round still waits for staff to accept it. Synthetic interception on
// the production build at 1440, 1024 and 390.
test("@production v15 batch-5: a staff round awaiting the card machine says so on its dishes, not waiting for staff", async ({
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
                acceptanceStatus: "NotAccepted",
                canRequestAcceptance: false,
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
                paymentDue: { status: "Awaiting", cancelsAt: "2099-09-14T00:30:00.000Z" },
                staffRound: {
                  recordedAfterOutage: false,
                  paidOnCardMachine: null,
                  amountDueMinor: null,
                },
              },
            ],
            canRequestAcceptance: false,
            currentPhase: "Submitted",
            currentVersion: 1,
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
    phase: "Submitted",
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
        phase: "Submitted",
        observedAt: "2026-09-14T00:01:00.000Z",
        items: [line(3, "Beef noodle soup", 0), line(4, "Green tea", 0)],
      },
    }),
  );
  await page.goto("/operations/orders");
  const round = page.getByRole("region", { name: "Round 1", exact: true });
  const soup = round.getByRole("listitem").filter({ hasText: "Beef noodle soup" });
  await expect(soup.getByText("Waiting for card-machine payment")).toBeVisible();
  await expect(round).not.toContainText("Waiting for staff");
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const waiting = soup.getByText("Waiting for card-machine payment");
    await waiting.scrollIntoViewIfNeeded();
    await expect(waiting).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/staff-round-card-machine-wait-${width}.png`,
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
