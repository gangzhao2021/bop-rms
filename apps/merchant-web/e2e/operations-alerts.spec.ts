import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): the Home shows the Owner and Store Manager what is wrong
// with the store system and what to do, in Store time, and keeps it current.
test("@production Home shows store system alerts with what to do, and their resolution (WP-2423 Q13)", async ({
  page,
}) => {
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference: "01909968-0000-7000-8000-000000000099",
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
          businessDate: "2026-10-15",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "HOME-OVERVIEW",
              label: "Overview",
              href: "/app",
              permission: "merchant.access",
            },
            {
              screenId: "OPS-ORDER-EXCEPTION",
              label: "Exceptions",
              href: "/operations/order-exceptions",
              permission: "operations.order-exception.manage",
            },
          ],
        },
      },
    }),
  );
  // Workspace reads every Store page makes (session activity, business day, PIN status).
  await page.route("**/merchant/session/activity", (route) =>
    route.fulfill({
      headers,
      json: {
        idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
        idleTimeoutMinutes: 30,
        serverTime: new Date().toISOString(),
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-15",
        startsAt: "2026-10-15T08:00:00.000Z",
        endsAt: "2026-10-16T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: "2026-10-15T16:00:00.000Z",
      },
    }),
  );
  await page.route("**/merchant/staff-pin", (route) =>
    route.fulfill({
      headers,
      json: {
        pin: { state: "Set", changedAt: "2026-10-01T16:00:00.000Z", lockedUntil: null },
        signIn: "Account",
        verifiedUntil: null,
      },
    }),
  );
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-EXCEPTION",
        projectionName: "merchant_order_exception_v1",
        storeLabel: scope.storeLabel,
        businessDate: "2026-10-15",
        projectedAt: "2026-10-15T16:00:00.000Z",
        freshnessStatus: "Fresh",
        items: [],
      },
    }),
  );
  const problem = {
    monitor: "Reporting",
    observedAt: "2026-10-15T16:00:00.000Z",
    active: [
      {
        key: "entry.customer",
        severity: "critical",
        title: "Customer ordering page is not loading",
        summary:
          "The secure customer ordering page has not loaded for 4 minutes. Guests cannot scan, order or pay online.",
        action:
          "Pause online ordering if staff screens still work, otherwise follow the store outage procedure. Ask the pilot operator to restart the pilot.",
        raisedAt: "2026-10-15T15:56:00.000Z",
      },
      {
        key: "certificate.expiring",
        severity: "warning",
        title: "Secure connection certificate expires soon",
        summary:
          "It expires in 6 days. After that, guests and staff devices will refuse to open the store pages.",
        action:
          "Ask the pilot operator to renew the secure connection certificate and trust the new one on staff devices.",
        raisedAt: "2026-10-15T09:00:00.000Z",
      },
    ],
    recentlyCleared: [],
    outbound: { email: true, webhooks: 0, heartbeat: false },
    lastSuccessfulBackupAt: "2026-10-15T08:30:00.000Z",
  };
  let board: unknown = problem;
  const requested: string[] = [];
  await page.route("**/merchant/operations-alerts", (route) => {
    requested.push(route.request().method());
    return route.fulfill({ headers, json: board });
  });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/app");
  const card = page.getByRole("region", { name: "Store system" });
  await expect(card.getByText("Customer ordering page is not loading")).toBeVisible();
  await expect(card.getByText("Urgent")).toBeVisible();
  await expect(card.getByText("Today", { exact: true })).toBeVisible();
  await expect(
    card.getByText(/What to do: Pause online ordering if staff screens still work/u),
  ).toBeVisible();
  await expect(card.getByText("Since Oct 15, 2026, 11:56 AM")).toBeVisible();
  await expect(card.getByText("Last backup Oct 15, 2026, 4:30 AM", { exact: false })).toBeVisible();
  await expect(card.getByText("The Owner is also alerted by email.")).toBeVisible();
  await expectNoInternalText(page);
  // The most urgent card comes first on the Home, above "Right now".
  const cardBox = await card.boundingBox();
  const nowBox = await page.getByRole("region", { name: "Right now" }).boundingBox();
  expect(cardBox && nowBox && cardBox.y < nowBox.y).toBe(true);
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/home-system-alerts-${width}.png`, fullPage: true });
  }

  // Resolved: "Check again" re-reads, the card says so and lists what was resolved.
  board = {
    ...problem,
    observedAt: "2026-10-15T16:05:00.000Z",
    active: [],
    recentlyCleared: [
      {
        key: "entry.customer",
        title: "Customer ordering page is not loading",
        clearedAt: "2026-10-15T16:04:00.000Z",
      },
    ],
  };
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(card.getByText("Everything is working.")).toBeVisible();
  await expect(
    card.getByText(/Resolved recently: Customer ordering page is not loading/u),
  ).toBeVisible();

  // The monitor stopped: nothing is being checked, said plainly.
  board = { ...problem, monitor: "Silent", active: [] };
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(
    card.getByText(/The alert monitor stopped reporting at Oct 15, 2026/u),
  ).toBeVisible();
  expect(requested.every((method) => method === "GET")).toBe(true);
  expect(errors).toEqual([]);
});
