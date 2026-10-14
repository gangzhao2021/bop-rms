import { expect, test } from "@playwright/test";

/** WP-2423 Q9-G1 (DEC-OUTAGE-ACCEPTANCE-HOLD): staff decide orders paid while the store was offline. */
test("@production orders paid during an outage are listed for a decision: accept or refund", async ({
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
  const now = Date.now();
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  let refunded = false;
  const held = (n: number, decideBy: string | null) => ({
    orderReference: id(n),
    orderNumber: "ORD-" + n,
    orderType: "Pickup",
    sourceChannel: "Web",
    submittedAt: at(-90),
    observedAt: at(0),
    initialBatchReference: id(n + 50),
    batches: [
      {
        orderBatchReference: id(n + 50),
        sequence: 1,
        acceptanceStatus: "NotAccepted",
        canRequestAcceptance: true,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: true,
    currentPhase: "Submitted",
    currentVersion: 1,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: decideBy,
    acceptanceHold: {
      holdReference: id(n + 70),
      orderBatchReference: id(n + 50),
      heldAt: at(-59),
      lapsedDeadline: at(-60),
      storeLastSeenAt: at(-75),
      decideBy,
      refundChosen: false,
      canRefund: true,
    },
    awaitingPayment: false,
  });
  const normal = {
    ...held(3, null),
    acceptanceHold: null,
    acceptBy: at(20),
  };
  const refundBodies: unknown[] = [];
  await page.route("**/merchant/orders/acceptance-hold/refund", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    refundBodies.push(route.request().postDataJSON());
    refunded = true;
    await route.fulfill({
      headers,
      json: { status: "RefundChosen", orderReference: id(2), decidedAt: at(0) },
    });
  });
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          normal,
          refunded
            ? {
                ...held(2, at(12)),
                acceptanceHold: {
                  ...held(2, at(0)).acceptanceHold,
                  decideBy: at(0),
                  refundChosen: true,
                  canRefund: false,
                },
                acceptBy: at(0),
              }
            : held(2, at(12)),
          held(1, null),
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.goto("/operations/orders");
  const notice = page.getByRole("status").filter({ hasText: "Paid during an outage — decide" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("2 online orders were paid while the store was offline.");
  await expect(page.getByText("Paid during an outage · decide", { exact: true })).toBeVisible();
  await expect(page.getByText("Paid during an outage · decide within 12 min")).toBeVisible();
  await expect(page.getByText("Accept within 20 min")).toBeVisible();
  await page.getByRole("button", { name: "Show these orders" }).click();
  const visible = page.locator("details.order-workbench-entry:visible");
  await expect(visible).toHaveCount(2);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(notice).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/outage-hold-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const order2 = page.locator("details.order-workbench-entry").filter({ hasText: "ORD-2" });
  await order2.locator("summary").click();
  await expect(order2).toContainText("It was not refunded automatically.");
  await expect(order2).toContainText("If you already made it from a paper ticket, accept it");
  await expect(order2.getByRole("button", { name: /Accept/u })).toBeVisible();
  await order2.getByRole("button", { name: "Refund instead" }).click();
  const dialog = page.getByRole("dialog", { name: "Refund order ORD-2" });
  await expect(dialog).toContainText("refunded in full to their original payment method");
  await dialog.getByRole("button", { name: "Refund order" }).click();
  await expect(dialog).toBeHidden();
  expect(refundBodies).toEqual([
    { orderReference: id(2), orderBatchReference: id(52), holdReference: id(72) },
  ]);
  await expect(page.getByText("Refund chosen · refund pending")).toBeVisible();
  await expect(order2).toContainText("You chose to refund this order.");
  await expect(order2.getByRole("button", { name: /Accept/u })).toHaveCount(0);
  await expect(notice).toContainText("1 online order was paid while the store was offline.");
  // No internal codes or references are shown to staff.
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/StaffRefund|StoreBackOnline|hold_?id|0190996[0-9]-/u);
});
