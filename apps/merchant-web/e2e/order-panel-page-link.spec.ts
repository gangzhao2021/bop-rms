import { expect, test } from "@playwright/test";
import { orderPanel } from "./order-queue-helpers";

/**
 * v15 batch 9 live finding: with a paid pickup open on Orders at 1440 × 900, "Open full page"
 * under Record sat partly under the sticky black Accept bar, hard to read and to click (whatever
 * the order's length, the panel's last line is the one at the bar's edge). It is in the panel's
 * head now, under the title: in view as the panel opens and never under the bar, at every width.
 */
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

test("@production the open order's Open full page is never under the Accept bar", async ({
  page,
}) => {
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  await page.clock.install({ time: new Date("2026-11-11T17:01:00.000Z") });
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
          businessDate: "2026-11-11",
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
  const order = (n: number) => ({
    orderReference: id(n),
    orderNumber: "ORD-" + n,
    orderType: "Pickup",
    sourceChannel: "Web",
    submittedAt: "2026-11-11T17:00:00.000Z",
    observedAt: "2026-11-11T17:01:00.000Z",
    initialBatchReference: id(100 + n),
    batches: [
      {
        orderBatchReference: id(100 + n),
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
    acceptBy: "2026-11-11T17:30:00.000Z",
    awaitingPayment: false,
    paidOnline: money("11304"),
  });
  const line = (n: number) => ({
    orderItemReference: id(200 + n),
    orderBatchReference: id(121),
    name: "Synthetic dish " + n,
    options: [],
    quantity: 1,
    customerNote: null,
    unitPrice: money("1250"),
    subtotal: money("1250"),
    discount: money("0"),
    tax: money("163"),
    fee: money("0"),
    total: money("1413"),
    canCancel: false,
    cancellation: null,
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({
      headers,
      json: { items: [order(22), order(21)], nextAfterOrderReference: null },
    }),
  );
  let dishes = 8;
  await page.route("**/merchant/orders/detail*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: { ...order(21), kitchenPhase: null },
        paymentPosition: { refundedMinor: "0", refundPendingMinor: "0" },
        // A long order, so the panel scrolls and the Accept bar stays at its foot.
        lines: {
          items: Array.from({ length: dishes }, (_, index) => line(index + 1)),
          totals: {
            subtotal: money("10000"),
            discount: money("0"),
            tax: money("1304"),
            fee: money("0"),
            total: money("11304"),
          },
        },
      },
    }),
  );
  // As opened, before any scrolling: whatever the order's length, the link is in view, under the
  // title, and clear of the bar.
  await page.setViewportSize({ width: 1440, height: 900 });
  for (dishes = 6; dishes <= 13; dishes++) {
    await page.goto("/operations/orders");
    await page.getByRole("button", { name: "ORD-21", exact: true }).click();
    const panel = orderPanel(page);
    const link = panel.getByRole("link", { name: "Open full page" });
    await expect(panel.getByText("Synthetic dish " + dishes, { exact: true })).toBeVisible();
    const box = await link.boundingBox();
    const bar = await panel.locator(".order-panel__next").boundingBox();
    const title = await panel.getByRole("heading", { name: "Order ORD-21" }).boundingBox();
    expect(box !== null && bar !== null && title !== null).toBe(true);
    if (box === null || bar === null || title === null) return;
    expect(box.y >= title.y + title.height && box.y + box.height <= 900).toBe(true);
    expect(
      box.y + box.height <= bar.y || box.y >= bar.y + bar.height,
      `${dishes} dishes: link ${box.y}–${box.y + box.height}, bar ${bar.y}–${bar.y + bar.height}`,
    ).toBe(true);
  }
  dishes = 8;
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/operations/orders");
    await page.getByRole("button", { name: "ORD-21", exact: true }).click();
    const panel = orderPanel(page);
    const link = panel.getByRole("link", { name: "Open full page" });
    const accept = panel.getByRole("button", { name: /^Accept/u }).first();
    await expect(link).toBeVisible();
    await expect(accept).toBeVisible();
    // As the order opens: under the title, clear of the bar, and what a tap on it hits.
    const box = await link.boundingBox();
    const bar = await panel.locator(".order-panel__next").boundingBox();
    expect(box !== null && bar !== null).toBe(true);
    if (box === null || bar === null) return;
    // Not overlapped by the bar, and the link itself is what a tap on it hits.
    expect(box.y + box.height <= bar.y || box.y >= bar.y + bar.height).toBe(true);
    expect(
      await link.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + 4, rect.top + rect.height / 2);
        return hit !== null && element.contains(hit);
      }),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/order-panel-page-link-${width}.png` });
  }
});
