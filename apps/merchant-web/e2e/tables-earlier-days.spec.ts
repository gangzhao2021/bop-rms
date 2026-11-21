import { expect, test } from "@playwright/test";

// b39 (v15 b38 dinner sweep): on Tables, a guest's call says what they chose, a table left open
// from an earlier business day is listed apart (out of "need you"), its wait reads in days with no
// "just now" beside it, and before closing staff are told how many of today's tables are still
// open. Synthetic fixtures only.
const id = (n: number) => "0190996d-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
// 21:30 in Toronto; the Store closes at 22:00 and the business day ends at 04:00.
const now = "2026-11-21T02:30:00.000Z";

test("@production b39: Tables keeps earlier days apart, says what a guest asked for and warns before closing", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(now));
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
          businessDate: "2026-11-20",
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
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-11-20",
        startsAt: "2026-11-20T09:00:00.000Z",
        endsAt: "2026-11-21T09:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: now,
        lastOrdersAt: null,
        closesAt: "2026-11-21T03:00:00.000Z",
        closedToday: false,
      },
    }),
  );
  const table = (n: number, label: string, extra: Record<string, unknown>) => ({
    tableReference: id(n),
    stableLabel: label,
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 2,
    currentDiningSessionReference: id(10 + n),
    elapsedMinutes: 30,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: [],
    staffCall: null,
    ...extra,
  });
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: false,
        canTransferHost: false,
        canCancelUnpaidRounds: false,
        items: [
          table(1, "H3", {
            staffCall: {
              callReference: id(31),
              reason: "TableNeeds",
              calledAt: new Date(Date.parse(now) - 2 * 60_000).toISOString(),
            },
          }),
          table(2, "H4", {}),
          // Seated two weeks ago and never closed; its last round waited for staff since then.
          table(3, "5", {
            elapsedMinutes: 21_563,
            heldRounds: [
              {
                orderReference: id(40),
                orderBatchReference: id(41),
                roundNumber: 3,
                heldAt: "2026-11-06T23:00:00.000Z",
                reason: "PhoneRapid",
              },
            ],
          }),
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/staff-calls/count", (route) =>
    route.fulfill({ headers, json: { open: 1 } }),
  );

  await page.goto("/operations/dining");
  const list = page.getByRole("region", { name: "Tables by what they need" });
  const rows = list.locator(".table-row");
  await expect(rows.first()).toContainText("Table H3");
  await expect(rows.first()).toContainText("Asked for staff2 min ago · Water, cutlery, napkins");
  // The earlier day's table is not among the evening's: "need you" counts only H3.
  await expect(page.getByText("1 need you")).toBeVisible();
  await expect(page.getByText("1 table from earlier days")).toBeVisible();
  await expect(list.getByRole("heading", { name: "From earlier days" })).toBeVisible();
  const earlier = list.locator(".table-rows").last().locator(".table-row");
  await expect(earlier).toHaveCount(1);
  await expect(earlier).toContainText("Table 5");
  await expect(earlier).toContainText("14 days");
  await expect(list.getByText(/just now · \d+ days? ago/u)).toHaveCount(0);
  await expect(list.getByText(/\d{4,} min/u)).toHaveCount(0);
  // Half an hour before closing: today's two seated tables, said on this page.
  await expect(
    page.getByText(
      /^Closing at 10:00\s?(PM|p\.m\.): 2 tables still open\. Take each table's payment and close it when the guests leave\.$/u,
    ),
  ).toBeVisible();
  // b40 (v15 b39 live: "8 seated", Seated 8 with no table seated today): the header and every
  // tab count today's tables only; the earlier day's table is counted and listed apart.
  const summary = page.locator(".dining-floor-summary");
  await expect(summary).toContainText("2 seated");
  await expect(summary).not.toContainText("3 seated");
  const tabs = page.getByRole("navigation", { name: "Show tables" });
  await expect(tabs.getByRole("button", { name: /^All/u })).toHaveText("All 2");
  await expect(tabs.getByRole("button", { name: /^Seated/u })).toHaveText("Seated 2");
  for (const name of ["Seated", "All"]) {
    await tabs.getByRole("button", { name: new RegExp("^" + name, "u") }).click();
    await expect(list.getByRole("heading", { name: "From earlier days" })).toBeVisible();
    await expect(list.locator(".table-rows").first().locator(".table-row")).toHaveCount(2);
    await expect(list.locator(".table-rows").last().locator(".table-row")).toContainText("Table 5");
  }
  await tabs.getByRole("button", { name: /^Needs action/u }).click();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `test-results/b39-tables-earlier-days-${width}.png`,
      fullPage: true,
    });
  }
});
