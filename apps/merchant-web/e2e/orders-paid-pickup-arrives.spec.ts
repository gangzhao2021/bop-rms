import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 (reads-under-burst, v15 2026-11-13): a freshly paid pickup reached Orders 30-70 s late:
 * the screen read its whole list only every 10 s, and in a rush that heavy read ran long or said
 * busy. Orders now asks every few seconds whether anything changed among the Store's Orders, and
 * reads the list at once when it did, so a paid pickup shows within a few seconds.
 */
const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const session = {
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
};
const order = (n: number, type: "DineIn" | "Pickup", submittedAt: string) => ({
  orderReference: id(n),
  orderNumber: "ORD-" + n,
  orderType: type,
  sourceChannel: "Web",
  submittedAt,
  observedAt: submittedAt,
  initialBatchReference: id(200 + n),
  batches: [
    {
      orderBatchReference: id(200 + n),
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
  acceptBy: null,
  awaitingPayment: false,
});

for (const screen of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 1024, height: 768 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`@production ${screen.name}: a freshly paid pickup shows on Orders within a few seconds`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: screen.width, height: screen.height });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const listed = [order(2, "DineIn", new Date(Date.now() - 120_000).toISOString())];
    let mark = "1".padStart(32, "0");
    let listReads = 0;
    let looks = 0;
    await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
    await page.route("**/merchant/orders/changes", (route) => {
      looks += 1;
      return route.fulfill({ headers, json: { schemaVersion: 1, mark } });
    });
    for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
      await page.route(pattern, (route) => {
        listReads += 1;
        return route.fulfill({
          headers,
          json: { items: [...listed].reverse(), nextAfterOrderReference: null },
        });
      });
    await page.goto("/operations/orders");
    await expect(page.getByRole("heading", { name: "ORD-2", exact: true })).toBeVisible();
    // The screen keeps asking whether anything changed (a light read), not reading the list.
    await expect.poll(() => looks, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
    const readsBefore = listReads;
    // A guest pays for a pickup: the Store's Orders change.
    listed.push(order(3, "Pickup", new Date().toISOString()));
    mark = "2".padStart(32, "0");
    const paidAt = Date.now();
    await expect(page.getByRole("heading", { name: "ORD-3", exact: true })).toBeVisible({
      timeout: 6_000,
    });
    const shownAfterMs = Date.now() - paidAt;
    // Well inside the 10 s the whole list used to wait, and read once for the change.
    expect(shownAfterMs).toBeLessThan(5_000);
    expect(listReads - readsBefore).toBeLessThanOrEqual(2);
    await page.screenshot({
      path: test.info().outputPath("orders-paid-pickup-" + screen.width + ".png"),
      fullPage: false,
    });
    await expectNoInternalText(page);
    expect(errors).toEqual([]);
  });
}
