import { expect, test } from "@playwright/test";

/**
 * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): the Tables board warns before an unpaid
 * guest round is cancelled, and a manager cancels it from the selected table. Synthetic HTTP
 * fixtures exercise the built page; the server rules run in the database acceptance.
 */
test("@production WP-2423: Tables warns about a guest round nobody paid for and a manager cancels it", async ({
  page,
}) => {
  const id = (n: number) => "0190996b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-10-16",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
          ],
        },
      },
    }),
  );
  const payBy = new Date(Date.now() + 7 * 60_000).toISOString();
  let cancelled = false;
  const posts: unknown[] = [];
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCancelUnpaidRounds: true,
        items: [
          {
            tableReference: id(1),
            stableLabel: "DEMO-02",
            areaCode: "DEMO",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 2,
            currentDiningSessionReference: id(11),
            elapsedMinutes: 45,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            staffRoundsAwaitingPayment: [],
            guestRoundsAwaitingPayment: cancelled
              ? []
              : [
                  {
                    orderReference: id(20),
                    orderBatchReference: id(21),
                    roundNumber: 1,
                    payBy,
                  },
                ],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/orders/cancel-unpaid-round", (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    posts.push(route.request().postDataJSON());
    cancelled = true;
    return route.fulfill({
      headers,
      json: { status: "Cancelled", cancelledAt: new Date().toISOString() },
    });
  });
  await page.goto("/operations/dining");
  const tile = page
    .locator(".dining-table-tile")
    .filter({ has: page.getByRole("button", { name: "Select DEMO-02", exact: true }) });
  // Last 10 minutes: urgent, with the minutes left and what to do.
  await expect(tile).toContainText(/\d+ min left: Round 1 isn't paid/u);
  await tile.getByRole("button", { name: "Select DEMO-02", exact: true }).click();
  const unpaid = page.getByRole("region", { name: "Unpaid rounds" });
  await expect(unpaid).toContainText("If the guest won't pay for it, cancel it now.");
  // Staff words only: no references or codes in the warning or the action.
  await expect(unpaid).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-7|_[A-Z]|UNPAID/u);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/tables-unpaid-round-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await unpaid.getByRole("button", { name: "Cancel unpaid round 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel unpaid round 1 of table DEMO-02?" });
  await dialog.getByRole("button", { name: "Cancel round 1", exact: true }).click();
  await expect(page.getByRole("region", { name: "Unpaid rounds" })).toHaveCount(0);
  await expect(tile).not.toContainText("isn't paid");
  expect(posts).toEqual([
    {
      orderReference: id(20),
      orderBatchReference: id(21),
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    },
  ]);
});
