import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { orderPanel, orderRows } from "./order-queue-helpers";

/**
 * WP-2423 table-move-payment (v15 fabf0261, 2026-11-06): a guest paid a round at table 窗边 1 号,
 * staff moved the party to Table 2 before accepting it, and Accept answered "Acceptance could not
 * be confirmed" five times out of five. Orders now lists the paid round at the table the party
 * sits at, Accept is confirmed once, and Orders says it is being sent to the kitchen until the
 * worker releases it. Synthetic HTTP interception on the production build: the server half (the
 * acceptance, the release and the kitchen ticket's table) is proven by the restricted-role
 * acceptance dining-move-paid-round; the kitchen ticket's "Moved from table" line by kitchen-queue.
 */
const id = (n: number) => "01a0f0e5-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const start = Date.parse("2026-11-06T20:00:00.000Z");
const ago = (seconds: number) => new Date(start - seconds * 1000).toISOString();

type Stage = "Paid" | "Sending" | "InKitchen";
const queue = (stage: Stage) => ({
  items: [
    {
      orderReference: id(1),
      orderNumber: "24",
      orderType: "DineIn",
      sourceChannel: "Qr",
      submittedAt: ago(120),
      observedAt: ago(0),
      initialBatchReference: id(51),
      batches: [
        {
          orderBatchReference: id(51),
          sequence: 1,
          acceptanceStatus: stage === "Paid" ? "NotAccepted" : "Accepted",
          canRequestAcceptance: stage === "Paid",
          canCancel: stage === "Paid",
          staffCancellation: null,
          canCancelItems: false,
          kitchenRelease: stage === "Sending" ? { state: "Sending", acceptedAt: ago(0) } : null,
          automaticRefundLate: false,
        },
      ],
      canRequestAcceptance: stage === "Paid",
      currentPhase: stage === "Paid" ? "Submitted" : "Accepted",
      currentVersion: stage === "Paid" ? 1 : 2,
      unfulfillable: null,
      pickupNotCollected: false,
      acceptBy: null,
      acceptanceHold: null,
      awaitingPayment: false,
      // The party sits at Table 2 now: the round goes with it.
      summary: {
        items: [{ name: "Egg waffle (TEST)", option: null, quantity: 1 }],
        lineCount: 1,
        pickupName: null,
        tableLabel: "2",
      },
    },
  ],
  nextAfterOrderReference: null,
});

async function signIn(page: Page) {
  await page.clock.install({ time: new Date(start) });
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
          businessDate: "2026-11-06",
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
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-11-06",
        startsAt: "2026-11-06T09:00:00.000Z",
        endsAt: "2026-11-07T09:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: ago(0),
      },
    }),
  );
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, status: 403, json: { error: "denied" } }),
  );
}

test("@production a paid round moved to another table is accepted there once and sent to the kitchen", async ({
  page,
}) => {
  await signIn(page);
  let stage: Stage = "Paid";
  const accepted: string[] = [];
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: queue(stage) }));
  await page.route("**/merchant/orders/accept", async (route) => {
    expect(route.request().method()).toBe("POST");
    accepted.push(route.request().postData() ?? "");
    stage = "Sending";
    await route.fulfill({ headers, json: { status: "Created", acceptedOrderVersion: 2 } });
  });
  await page.goto("/operations/orders");
  const row = orderRows(page).filter({ hasText: "Table 2" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Egg waffle (TEST)");
  // The only order opens by itself; its Accept is in the opened order.
  await expect(row.getByRole("button", { name: "24", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const accept = orderPanel(page).getByRole("button", { name: /^Accept/u });
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(
    orderPanel(page).getByRole("status").filter({ hasText: "Sending to the kitchen…" }),
  ).toBeVisible();
  await expect(
    page.getByText("can't tell whether this order was accepted", { exact: false }),
  ).toHaveCount(0);
  expect(accepted).toHaveLength(1);
  expect(JSON.parse(accepted[0] ?? "{}")).toMatchObject({
    orderReference: id(1),
    orderBatchReference: id(51),
    expectedOrderVersion: 1,
  });
  // The worker releases it: Orders no longer says it is on its way, nor that it is missing.
  stage = "InKitchen";
  await page.getByRole("button", { name: "Refresh orders", exact: true }).click();
  await expect(orderPanel(page)).not.toContainText("Sending to the kitchen…");
  await expect(orderPanel(page)).not.toContainText("Not in the kitchen yet");
  await expect(orderRows(page).filter({ hasText: "Table 2" })).toHaveCount(1);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/dining-move-paid-round-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);
});
