import { expect, test } from "@playwright/test";

// WP-2423 Q28 DEC-DINING-STAFF-CALL: staff see guests waiting for them on every page (navigation
// count) and on the Tables page, and mark a call handled there. Synthetic fixtures only.
test("@production staff see guests asking for staff and mark a call handled", async ({ page }) => {
  const id = (n: number) => "0190996d-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
          businessDate: "2026-10-25",
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
  const now = Date.now();
  let calls: Record<string, { callReference: string; reason: string; calledAt: string } | null> = {
    T1: {
      callReference: id(31),
      reason: "TableNeeds",
      calledAt: new Date(now - 7 * 60_000).toISOString(),
    },
    T2: {
      callReference: id(32),
      reason: "Question",
      calledAt: new Date(now - 60_000).toISOString(),
    },
  };
  const table = (n: number, label: string) => ({
    tableReference: id(n),
    stableLabel: label,
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 2,
    currentDiningSessionReference: id(10 + n),
    elapsedMinutes: 20,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: [],
    staffCall: calls[label] ?? null,
  });
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: false,
        canTransferHost: false,
        canCancelUnpaidRounds: false,
        items: [table(1, "T1"), table(2, "T2")],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/staff-calls/count", (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    return route.fulfill({
      headers,
      json: { open: Object.values(calls).filter((call) => call !== null).length },
    });
  });
  const answered: unknown[] = [];
  await page.route("**/merchant/dining/staff-calls/answer", (route) => {
    const body = route.request().postDataJSON() as { callReference: string };
    answered.push(body);
    calls = { ...calls, T1: null };
    return route.fulfill({ headers, json: { status: "Answered" } });
  });

  await page.goto("/operations/dining");
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await expect(navigation.getByRole("link", { name: "Tables 2 waiting" })).toBeVisible();
  const list = page.getByRole("alert").filter({ hasText: "Guests asking for staff" });
  await expect(list).toBeVisible();
  const items = list.getByRole("listitem");
  // Oldest first, urgent after 5 minutes.
  await expect(items.nth(0)).toContainText("Table T1");
  await expect(items.nth(0)).toContainText("7 min ago · Something for the table");
  await expect(items.nth(0)).toHaveAttribute("data-tier", "urgent");
  await expect(items.nth(1)).toContainText("1 min ago · A question");
  await expect(page.locator(".dining-table-tile").first()).toContainText("Guest asked for staff");
  await items.nth(0).getByRole("button", { name: "Handled" }).click();
  await expect(page.getByText("Table T1: marked as handled.")).toBeVisible();
  expect(answered).toHaveLength(1);
  expect(answered[0]).toMatchObject({ callReference: id(31) });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
});
