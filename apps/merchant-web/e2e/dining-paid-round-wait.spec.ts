import { expect, test } from "@playwright/test";

/**
 * WP-2423 (DEC-DINE-IN-PAID-ROUND-WAIT): a paid dine-in round waits for staff to accept it and is
 * never refunded by a timer, so the Tables board says how long it has waited (urgent from 10
 * minutes). Synthetic HTTP fixtures exercise the built page; the server read runs in the database
 * acceptance (dining-round-acceptance-order).
 */
test("@production WP-2423: Tables says how long a paid round has waited for acceptance", async ({
  page,
}) => {
  const id = (n: number) => "0190996c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const table = (n: number, label: string, rounds: readonly unknown[]) => ({
    tableReference: id(n),
    stableLabel: label,
    areaCode: "DEMO",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 2,
    currentDiningSessionReference: id(n + 10),
    elapsedMinutes: 30,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: rounds,
  });
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCancelUnpaidRounds: false,
        items: [
          table(1, "DEMO-01", [{ roundNumber: 1, paidAt: minutesAgo(6) }]),
          table(2, "DEMO-02", [
            { roundNumber: 2, paidAt: minutesAgo(12) },
            { roundNumber: 3, paidAt: minutesAgo(2) },
          ]),
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.goto("/operations/dining");
  // WP-2423 item 8 ①: the list row says how long the round has waited (red from 10 minutes);
  // the table's panel says what to do.
  const tile = (label: string) =>
    page
      .locator(".table-row")
      .filter({ has: page.getByRole("button", { name: `Select ${label}`, exact: true }) });
  await expect(tile("DEMO-01")).toContainText(/Paid round to accept\s*paid [56] min ago/u);
  await expect(tile("DEMO-01")).toHaveAttribute("data-urgent", "false");
  await expect(tile("DEMO-02")).toContainText(/paid 1[23] min ago/u);
  await expect(tile("DEMO-02")).toHaveAttribute("data-urgent", "true");
  await tile("DEMO-02").getByRole("button", { name: "Select DEMO-02", exact: true }).click();
  await expect(page.getByRole("note").filter({ hasText: "and still not accepted" })).toContainText(
    /Round 2 paid 1[23] min ago and still not accepted · accept it on the Orders page now \(and 1 more paid round\)/u,
  );
  const note = page.getByRole("note").filter({ hasText: "Round 2 paid" });
  await expect(note).toBeVisible();
  // Staff words only: no references or codes.
  await expect(note).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-7|_[A-Z]/u);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/tables-paid-round-wait-${width}.png`,
      fullPage: true,
    });
  }
});
