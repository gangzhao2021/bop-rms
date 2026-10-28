import { expect, test } from "@playwright/test";

/** WP-2423: the Tables board says how long a table has been open and flags what staff must act on. */
test("@production Tables board shows open time in hours or days and flags long-open tables and missing codes", async ({
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
          businessDate: "2026-10-14",
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
  const table = (n: number, label: string, extra: Record<string, unknown>) => ({
    tableReference: id(n),
    stableLabel: label,
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 2,
    currentDiningSessionReference: null,
    elapsedMinutes: null,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    ...extra,
  });
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        items: [
          table(1, "T1", { currentDiningSessionReference: id(11), elapsedMinutes: 200 }),
          table(2, "T2", { currentDiningSessionReference: id(12), elapsedMinutes: 34992 }),
          table(3, "T3", { qrCodeValidUntil: null }),
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.goto("/operations/dining");
  // WP-2423 item 8 ①: tables are listed by what they need; a table open far too long is one.
  const tile = (label: string) =>
    page
      .locator(".table-row, .table-free li")
      .filter({ has: page.getByRole("button", { name: "Select " + label, exact: true }) });
  await expect(tile("T1")).toContainText("Seats 4 · 3 h 20 min");
  await expect(tile("T1")).not.toContainText("Open a long time");
  await expect(tile("T2")).toContainText("Seats 4 · 24 days");
  await expect(tile("T2")).toContainText("Open a long time");
  await expect(tile("T3")).toContainText("No table QR code");
  await tile("T2").getByRole("button", { name: "Select T2", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Selected table details" })).toContainText(
    "Open for a long time — if the guests have left",
  );
  await tile("T3").getByRole("button", { name: "Select T3", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Selected table details" })).toContainText(
    "No table QR code. Ask a manager to print one.",
  );
  await expect(page.getByText(/34992|min elapsed/u)).toHaveCount(0);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(tile("T2")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/dining-floor-notices-${width}.png`,
      fullPage: true,
    });
  }
});

/** IDR-0039: a failed refresh keeps the last tables on screen, read-only, and recovers on its own. */
test("@production Tables keeps the last tables read-only after a failed refresh and recovers", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
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
          businessDate: "2026-10-14",
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
  let offline = false;
  await page.route("**/merchant/dining/tables", (route) =>
    offline
      ? route.abort("internetdisconnected")
      : route.fulfill({
          headers,
          json: {
            canOperateTables: false,
            items: [
              {
                tableReference: id(1),
                stableLabel: "T1",
                areaCode: "MAIN",
                capacity: 4,
                lifecycle: "Published",
                operationalState: "Available",
                aggregateVersion: 2,
                currentDiningSessionReference: null,
                elapsedMinutes: null,
                qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
              },
            ],
            nextAfterTableReference: null,
          },
        }),
  );
  await page.goto("/operations/dining");
  const select = page.getByRole("button", { name: "Select T1", exact: true });
  await expect(select).toBeEnabled();
  offline = true;
  await page.getByRole("button", { name: "Refresh tables", exact: true }).click();
  const notice = page.getByRole("status").filter({ hasText: "Read-only until reconnected" });
  await expect(notice).toContainText(/showing the last update from \d\d:\d\d/u);
  await expect(select).toBeDisabled();
  await expect(page.getByText("Tables unavailable", { exact: false })).toHaveCount(0);
  // Operating continuity (WP-2423 item 8 ①): what servers do instead, on this screen.
  const guide = page.getByRole("note", { name: "While the connection is down" });
  await expect(guide).toContainText("Never write a card number.");
  await guide.getByText("When the connection is back, for each table").click();
  await expect(guide).toContainText(
    "Manager: record the comps and discounts from the slips first.",
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(notice).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/tables-offline-guide-390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  offline = false;
  await expect(notice).toHaveCount(0, { timeout: 15_000 });
  await expect(guide).toHaveCount(0);
  await expect(select).toBeEnabled();
  // The browser reporting the network gone is enough; back online it re-reads at once.
  await select.click();
  await context.setOffline(true);
  await expect(notice).toBeVisible({ timeout: 2_000 });
  await expect(select).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open table", exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(notice).toHaveCount(0, { timeout: 5_000 });
  await expect(select).toBeEnabled();
});
