import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 DEC-DINING-GUEST-TABLE-START: Tables shows the table a guest started, warns before it
 * frees itself, and lets whoever may pause ordering stop guests starting tables. Synthetic data;
 * the server's rules are proven by the database acceptance test (dining-guest-table-start).
 */
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
};
const headers = { "cache-control": "no-store" };
const base = (n: number) => ({
  tableReference: id(n),
  stableLabel: "T" + n,
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  aggregateVersion: 2,
  currentDiningSessionReference: null,
  elapsedMinutes: null,
  qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
  paymentTiming: "PayFirst",
});

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const) {
  test(`@production Tables shows a table a guest started, and the owner of the pause stops it (${String(width)})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
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
            businessDate: "2026-11-05",
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
    let on = true;
    const off: unknown[] = [];
    const soon = new Date(Date.now() + 7 * 60_000).toISOString();
    const later = new Date(Date.now() + 18 * 60_000).toISOString();
    const overdue = new Date(Date.now() - 15 * 60_000).toISOString();
    await page.route("**/merchant/dining/tables", (route) =>
      route.fulfill({
        headers,
        json: {
          canOperateTables: true,
          canCloseSessions: true,
          ...(on ? { guestTableStart: { version: 4, canTurnOff: true, startsBusy: true } } : {}),
          items: [
            {
              ...base(1),
              currentDiningSessionReference: id(11),
              elapsedMinutes: 3,
              session: { phase: "Active", version: 2, orderReference: null },
              // This party said the people here before them weren't theirs, ending that visit.
              guestStart: { closesByItselfAt: later, endedLastParty: true },
            },
            {
              ...base(2),
              currentDiningSessionReference: id(12),
              elapsedMinutes: 15,
              session: { phase: "Active", version: 2, orderReference: null },
              guestStart: { closesByItselfAt: soon },
            },
            {
              ...base(3),
              operationalState: "TemporarilyBlocked",
              blockReasonCode: "CLEANING",
              blockedSince: new Date(Date.now() - 6 * 60_000).toISOString(),
            },
            base(4),
            {
              // Past its time by more than the worker's cycle: something holds it.
              ...base(5),
              currentDiningSessionReference: id(15),
              elapsedMinutes: 45,
              session: { phase: "Active", version: 3, orderReference: null },
              guestStart: { closesByItselfAt: overdue },
            },
          ],
          nextAfterTableReference: null,
        },
      }),
    );
    await page.route("**/merchant/dining/guest-table-start/off", (route) => {
      off.push(route.request().postDataJSON());
      on = false;
      return route.fulfill({ headers, json: { guestTableStart: false, version: 5 } });
    });
    await page.goto("/operations/dining");
    await page.getByRole("button", { name: "All", exact: false }).first().click();
    const main = page.getByRole("main");
    await expect(main).toContainText("Started by a guest");
    await expect(main).toContainText("no order yet · frees itself in 7 min");
    // Whichever list staff are on, the top of the page says it first.
    await expect(main).toContainText("Table T2 frees itself in 7 min");
    // The warning waits for its last minutes: a countdown nobody can act on is just noise.
    await expect(main.getByText("frees itself in 18 min")).toHaveCount(0);
    await expect(main).toContainText("a new party ended the last visit");
    // Long past its time, it stops promising and asks a person to look.
    await expect(main).toContainText("Hasn’t freed itself");
    await expect(main).toContainText("guests can start it now");
    // Scanned starts ran out for now: staff are told why guests are coming to them.
    await expect(main).toContainText("new guests are sent to staff for a few minutes");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoInternalText(page);
    await page.screenshot({
      path: `test-results/dining-guest-started-${String(width)}.png`,
      fullPage: true,
    });

    // Asked once: only the owner can turn it back on, and until then guests go to staff.
    await main.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(main).toContainText(
      "New guests at free tables will be sent to staff. Only the owner can turn this back on.",
    );
    await main.getByRole("button", { name: "Keep on", exact: true }).click();
    expect(off).toEqual([]);
    await main.getByRole("button", { name: "Turn off", exact: true }).click();
    await main.getByRole("button", { name: "Yes, turn off", exact: true }).click();
    await expect(main).toContainText("New tables need staff to open them now.");
    expect(off).toEqual([expect.objectContaining({ expectedVersion: 4 })]);
    await expect(main.getByRole("button", { name: "Turn off", exact: true })).toHaveCount(0);
    await expect(main.getByText("new guests are sent to staff")).toHaveCount(0);
  });
}
