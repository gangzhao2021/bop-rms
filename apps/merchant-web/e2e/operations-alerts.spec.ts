import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// The real pilot navigation shape (tooling/environment/pilot-merchant.mjs), trimmed per role the
// way the BFF trims it by permission. The card must not depend on any one of these entries: the
// server's answer on /merchant/operations-alerts decides (the board for Owner/Store Manager, an
// ordinary "not permitted" answer for others: no refusal in the browser console).
type PilotRole = "owner" | "store-manager" | "front-of-house";
const pilotEntries: readonly (readonly [string, string, string, string, readonly PilotRole[]])[] = [
  [
    "STORE-SETUP",
    "Store setup",
    "/app/organization/stores/01909968-0000-7000-8000-000000000099/setup",
    "organization.manage",
    ["owner", "store-manager"],
  ],
  ["CAT-PRODUCT-LIST", "Products", "/app/commerce/products", "catalog.manage", ["owner"]],
  [
    "OPS-ORDER-QUEUE",
    "Orders",
    "/operations/orders",
    "ordering.operate",
    ["owner", "store-manager", "front-of-house"],
  ],
  [
    "OPS-ORDER-ENTRY",
    "Counter order",
    "/operations/order-entry",
    "ordering.order.create_staff",
    ["owner", "store-manager", "front-of-house"],
  ],
  [
    "KIT-KITCHEN-QUEUE",
    "Kitchen",
    "/operations/kitchen",
    "kitchen.operate",
    ["owner", "store-manager"],
  ],
  [
    "FUL-PICKUP-QUEUE",
    "Pickup",
    "/operations/pickup",
    "fulfillment.operate",
    ["owner", "store-manager", "front-of-house"],
  ],
  [
    "DIN-FLOOR-BOARD",
    "Tables",
    "/operations/dining",
    "dining.operate",
    ["owner", "store-manager", "front-of-house"],
  ],
  [
    "PAY-RECONCILIATION",
    "Settlement",
    "/app/operations/payment-reconciliation",
    "operations.order-exception.manage",
    ["owner", "store-manager"],
  ],
  [
    "OPS-ORDER-EXCEPTION",
    "Exceptions",
    "/operations/order-exceptions",
    "operations.order-exception.manage",
    ["owner", "store-manager"],
  ],
  [
    "RPT-OPS-DASHBOARD",
    "Reports",
    "/app/reports/operations",
    "reporting.sales.read",
    ["owner", "store-manager"],
  ],
];
const pilotNavigation = (role: PilotRole) =>
  pilotEntries
    .filter((entry) => entry[4].includes(role))
    .map(([screenId, label, href, permission]) => ({ screenId, label, href, permission }));

// WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): the Home shows the Owner and Store Manager what is wrong
// with the store system and what to do, in Store time, and keeps it current.
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: "01909968-0000-7000-8000-000000000099",
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };

/**
 * Routes every read the Home makes for a pilot role. The alerts route answers as the real BFF
 * does: the board for Owner and Store Manager, "not permitted" for everyone else. Any other merchant read is
 * recorded as unexpected so a new Home dependency is noticed instead of silently failing.
 */
async function pilotHome(
  page: Page,
  role: PilotRole,
  board: () => unknown,
  ownName: "Recorded" | "Missing" = "Recorded",
) {
  const alertReads: string[] = [];
  const nameSaves: unknown[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  await page.route("**/merchant/**", (route) => {
    unexpected.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, headers, json: { error: "not_found" } });
  });
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
          navigation: pilotNavigation(role),
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
  // The "Right now" summaries, empty: this spec is about the store system card.
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/pickup/query", (route) =>
    route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: {
          deviceReference: "01909968-0000-7000-8000-000000000010",
          pickupLocationReference: "01909968-0000-7000-8000-000000000011",
        },
        storeReference: scope.storeReference,
        observedAt: "2026-10-15T16:00:00.000Z",
        nextAfterFulfillmentReference: null,
        items: [],
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
  // WP-2423: Home asks a member with no recorded name to add one.
  let named = ownName === "Recorded";
  await page.route("**/merchant/organization/staff/me", (route) =>
    route.fulfill({
      headers,
      json: named
        ? { name: "Recorded", displayName: "Ava" }
        : { name: "Missing", profileVersion: 0 },
    }),
  );
  await page.route("**/merchant/organization/staff/me/name", (route) => {
    nameSaves.push(route.request().postDataJSON());
    named = true;
    return route.fulfill({ headers, json: { status: "Applied", profileVersion: 1 } });
  });
  await page.route("**/merchant/operations-alerts", (route) => {
    alertReads.push(route.request().method());
    return role === "front-of-house"
      ? route.fulfill({ headers, json: { permitted: false } })
      : route.fulfill({ headers, json: board() });
  });
  page.on("console", (message) => {
    // WP-2423: no exemption: front of house sees no refused request in the console either.
    if (message.type() !== "error") return;
    errors.push(message.text());
  });
  return { alertReads, unexpected, errors, nameSaves };
}

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

test("@production Home shows store system alerts with what to do, and their resolution (WP-2423 Q13)", async ({
  page,
}) => {
  let board: unknown = problem;
  const home = await pilotHome(page, "owner", () => board);
  const requested = home.alertReads;
  const errors = home.errors;

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
  expect(home.unexpected).toEqual([]);
});

// v15 finding: the pilot navigation has never had to carry an exceptions entry for the card to
// appear; the server's answer decides. Owner and Store Manager see it, front of house does not.
for (const role of ["owner", "store-manager"] as const)
  test(`@production Home shows the store system card to the ${role === "owner" ? "Owner" : "Store Manager"} with the pilot navigation (v15)`, async ({
    page,
  }) => {
    const home = await pilotHome(page, role, () => problem);
    await page.goto("/app");
    const card = page.getByRole("region", { name: "Store system" });
    await expect(card.getByText("Customer ordering page is not loading")).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Exceptions" }),
    ).toHaveAttribute("href", "/operations/order-exceptions");
    await expectNoInternalText(page);
    expect(home.errors).toEqual([]);
    expect(home.unexpected).toEqual([]);
  });

test("@production Home shows front of house no store system card and does not keep asking (v15)", async ({
  page,
}) => {
  await page.clock.install();
  const home = await pilotHome(page, "front-of-house", () => problem);
  await page.goto("/app");
  await expect(page.getByRole("region", { name: "Right now" })).toBeVisible();
  await expect.poll(() => home.alertReads.length).toBe(1);
  await expect(page.getByRole("region", { name: "Store system" })).toHaveCount(0);
  await expect(page.getByText("System alerts could not be read")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Exceptions" }),
  ).toHaveCount(0);
  // Two refresh periods later the Home has not asked again: "not permitted" stops the reading.
  await page.clock.runFor(130_000);
  await expect(page.getByRole("region", { name: "Right now" })).toBeVisible();
  expect(home.alertReads).toHaveLength(1);
  await expect(page.getByRole("region", { name: "Store system" })).toHaveCount(0);
  expect(home.errors).toEqual([]);
  expect(home.unexpected).toEqual([]);
});

// WP-2423: real stores label who did what. A member with no recorded name is asked on Home, once,
// in plain words, and the prompt goes away after saving.
test("@production Home asks a member with no name to add it, and thanks them once saved", async ({
  page,
}) => {
  const home = await pilotHome(page, "owner", () => problem, "Missing");
  await page.goto("/app");
  const prompt = page.getByRole("region", { name: "Add your name" });
  await expect(prompt.getByText("Add your name so your team sees who did what.")).toBeVisible();
  await prompt.getByRole("button", { name: "Save name" }).click();
  await expect(prompt.getByRole("alert")).toBeVisible();
  expect(home.nameSaves).toHaveLength(0);
  await prompt.getByLabel("Your name").fill("  Cole Park ");
  await prompt.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Thanks." })).toBeVisible();
  expect(home.nameSaves).toHaveLength(1);
  expect(home.nameSaves[0]).toMatchObject({ displayName: "Cole Park", expectedProfileVersion: 0 });
  await expect(page.getByRole("region", { name: "Add your name" })).toHaveCount(0);
  await expectNoInternalText(page);
  expect(home.errors).toEqual([]);
  expect(home.unexpected).toEqual([]);
});
