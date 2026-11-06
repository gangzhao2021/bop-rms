import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { settlementViewFixture } from "../src/settlement.fixtures";

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
    "payment.settlement.read",
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
  /** WP-2423 item 13 ②: whether the platform paused this merchant's new guests. */
  intake: { paused: boolean; since: string | null; reason: string | null } = {
    paused: false,
    since: null,
    reason: null,
  },
) {
  const alertReads: string[] = [];
  const nameSaves: unknown[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  await page.route("**/merchant/**", (route) => {
    unexpected.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, headers, json: { error: "not_found" } });
  });
  await page.route("**/merchant/store/guest-intake", (route) =>
    route.fulfill({ headers, json: intake }),
  );
  // The Owner's opening list on Home: a Store with every step done shows no list.
  await page.route("**/merchant/store/opening-list", (route) =>
    route.fulfill({
      headers,
      json: { setupPublished: true, allergenList: true, menuListed: true },
    }),
  );
  for (const read of ["store/public-profile", "store/receipt-profile", "dining/table-qr"])
    await page.route("**/merchant/" + read, (route) => route.fulfill({ headers, json: {} }));
  await page.route("**/merchant/store/kitchen-setup", (route) =>
    route.fulfill({
      headers,
      json: {
        canChange: true,
        version: 1,
        inEffectFrom: "2026-11-01T15:00:00.000Z",
        uncoveredDishes: [],
      },
    }),
  );
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
  // WP-2423 Q35/Q28: the navigation counts (refunds waiting for approval, guests waiting for staff).
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: true,
        soleOperator: null,
        entries: [],
      },
    }),
  );
  await page.route("**/merchant/dining/staff-calls/count", (route) =>
    route.fulfill({ headers, json: { open: 0 } }),
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
  // WP-2423 (3cd0f8dd M6/M7): the open tables and the last closed day's settlement on Home.
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: role !== "front-of-house",
        nextAfterTableReference: null,
        items: [],
      },
    }),
  );
  await page.route("**/merchant/settlement", (route) =>
    route.fulfill({ headers, json: settlementViewFixture() }),
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
  // Ordering is not about to stop, unless a test says so.
  await page.route("**/merchant/ordering-ending", (route) =>
    route.fulfill({ headers, json: { endsAt: null, support: null } }),
  );
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
        "Pause online ordering if staff screens still work, otherwise follow the store outage procedure. Ask BOP support to restart the store system.",
      raisedAt: "2026-10-15T15:56:00.000Z",
    },
    {
      key: "certificate.expiring",
      severity: "warning",
      title: "Secure connection certificate expires soon",
      summary:
        "It expires in 6 days. After that, guests and staff devices will refuse to open the store pages.",
      action:
        "Ask BOP support to renew the secure connection certificate and set up the new one on staff devices.",
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
  // Owner 2026-11-03: a real problem is a row in "Needs attention", the store system a quiet line.
  const needs = page.getByRole("region", { name: "Needs attention" });
  const card = page.getByRole("region", { name: "Store system" });
  await expect(needs.getByText("Customer ordering page is not loading")).toBeVisible();
  await expect(needs.getByText("Urgent")).toBeVisible();
  await expect(needs.getByText("Today", { exact: true })).toBeVisible();
  await expect(
    needs.getByText(/What to do: Pause online ordering if staff screens still work/u),
  ).toBeVisible();
  await expect(needs.getByText("Since Oct 15, 2026, 11:56 AM")).toBeVisible();
  await expect(
    needs.getByText("Guests cannot scan, order or pay online.", { exact: false }),
  ).toBeHidden();
  await needs.getByText("More about this").first().click();
  await expect(
    needs.getByText("Guests cannot scan, order or pay online.", { exact: false }),
  ).toBeVisible();
  await expect(card.getByText("Store system: needs attention")).toBeVisible();
  await expect(card.getByText("all good")).toHaveCount(0);
  await expect(card.getByText("Last backup Oct 15, 2026, 4:30 AM", { exact: false })).toBeVisible();
  await card.getByText("System details").click();
  await expect(card.getByText("The Owner is also alerted by email.")).toBeVisible();
  await expectNoInternalText(page);
  // The most urgent problem comes first on the Home, above "Right now"; the line comes last.
  const needsBox = await needs.boundingBox();
  const nowBox = await page.getByRole("region", { name: "Right now" }).boundingBox();
  const lineBox = await card.boundingBox();
  expect(needsBox && nowBox && lineBox && needsBox.y < nowBox.y && nowBox.y < lineBox.y).toBe(true);
  await expect(needs.locator("li").first()).toContainText("Customer ordering page is not loading");
  // Owner 2026-11-03: the way into Today's summary, for those with the reports screen.
  await expect(page.getByRole("link", { name: "Today's summary" })).toHaveAttribute(
    "href",
    "/app/reports/operations",
  );
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(needs).toBeVisible();
    await expect(card).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/home-system-alerts-${width}.png`, fullPage: true });
  }

  // Resolved: "Check again" re-reads, the line says so and lists what was resolved.
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
  await expect(card.getByText("Store system: all good")).toBeVisible();
  await expect(needs.getByText("Customer ordering page is not loading")).toHaveCount(0);
  await expect(
    card.getByText(/Resolved recently: Customer ordering page is not loading/u),
  ).toBeVisible();

  // WP-2423 (2026-10-18): a planned update is a calm notice, not an urgent outage.
  board = {
    ...problem,
    observedAt: "2026-10-15T16:06:00.000Z",
    active: [],
    plannedUpdate: { startedAt: "2026-10-15T16:05:30.000Z", expiresAt: "2026-10-15T16:20:30.000Z" },
  };
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(
    needs.getByText("System update in progress — ordering may pause for a few minutes."),
  ).toBeVisible();
  await expect(needs.getByText(/this page shows an urgent alert/u)).toBeVisible();
  await expect(needs.getByText("Urgent", { exact: true })).toHaveCount(0);
  await expect(card.getByText("all good")).toHaveCount(0);
  await expect(needs.locator(".overview-attention__state--danger")).toHaveCount(0);
  await expectNoInternalText(page);

  // The monitor stopped: nothing is being checked, said plainly.
  board = { ...problem, monitor: "Silent", active: [] };
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(
    needs.getByText(/The alert monitor stopped reporting at Oct 15, 2026/u),
  ).toBeVisible();
  await expect(card.getByText("Store system: problems are not being checked")).toBeVisible();
  expect(requested.every((method) => method === "GET")).toBe(true);
  expect(errors).toEqual([]);
  expect(home.unexpected).toEqual([]);
});

// WP-2423 item 9: when the store's order rules are refused, staff hear it on Home before a guest is
// stuck on "preparing payment". The words are the monitor's own catalog, the longest it writes.
test("@production Home says what a refused order Workflow stops and what staff do, at every width (WP-2423 item 9)", async ({
  page,
}) => {
  const catalog = new URL("../../../tooling/environment/pilot-alerts.mjs", import.meta.url).href;
  const { renderAlert } = (await import(catalog)) as {
    readonly renderAlert: (
      key: string,
      params: unknown,
    ) => { readonly title: string; readonly summary: string; readonly action: string };
  };
  const row = (key: string, params: unknown) => {
    const { title, summary, action } = renderAlert(key, params);
    return {
      key,
      severity: "critical",
      title,
      summary,
      action,
      raisedAt: "2026-10-15T15:56:00.000Z",
    };
  };
  const board = {
    ...problem,
    active: [
      row("orders.workflow", { state: "PaidOrders", refused: "Pickup:ExpectedVersionChanged" }),
      row("orders.unpaid_rounds", { refused: "Cancellation:TwoBrandVersions" }),
    ],
  };
  const home = await pilotHome(page, "owner", () => board);
  await page.goto("/app");
  const needs = page.getByRole("region", { name: "Needs attention" });
  await expect(
    needs.getByText(
      "Paid orders may not reach the kitchen, and paid pickup orders may be refunded automatically",
    ),
  ).toBeVisible();
  await expect(needs.getByText("Unpaid rounds are not being cancelled")).toBeVisible();
  await expect(
    needs.getByText(/What to do: Pause all services in Hours & ordering/u),
  ).toBeVisible();
  await expect(needs.getByText(/Call BOP support now/u).first()).toBeVisible();
  await needs.getByText("More about this").first().click();
  await expect(
    needs.getByText(/refunded automatically about 30 minutes after payment/u),
  ).toBeVisible();
  // Which binding refused and by which rule is for BOP's log, never on a screen.
  await expect(
    page.getByText(/ExpectedVersionChanged|TwoBrandVersions|Cancellation:/u),
  ).toHaveCount(0);
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(needs).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/home-order-workflow-${width}.png`,
      fullPage: true,
    });
  }
  expect(home.errors).toEqual([]);
  expect(home.unexpected).toEqual([]);
});

// WP-2423 item 9: the row can clear before the fix reaches the running services, so its clearing
// stays in "Needs attention", where the urgent row was, and tells staff to wait for BOP support.
test("@production Home keeps staff on paper when the order rules row clears (WP-2423 item 9)", async ({
  page,
}) => {
  const catalog = new URL("../../../tooling/environment/pilot-alerts.mjs", import.meta.url).href;
  const { clearedAlertTitle } = (await import(catalog)) as {
    readonly clearedAlertTitle: (key: string, params?: unknown) => string;
  };
  const board = {
    ...problem,
    active: [],
    recentlyCleared: [
      {
        key: "orders.workflow",
        title: clearedAlertTitle("orders.workflow", { state: "Pickup" }),
        clearedAt: "2026-10-15T15:58:00.000Z",
      },
    ],
  };
  const home = await pilotHome(page, "owner", () => board);
  await page.goto("/app");
  const needs = page.getByRole("region", { name: "Needs attention" });
  await expect(
    needs.getByText(
      /Order rules check passes again: stay on paper until BOP support says it is fixed/u,
    ),
  ).toBeVisible();
  await expect(needs.getByText("Wait for BOP support")).toBeVisible();
  await expect(page.getByText("Nothing needs attention right now.")).toHaveCount(0);
  await expect(page.getByText(/Resolved recently/u)).toHaveCount(0);
  await expectNoInternalText(page);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/home-order-workflow-cleared-${width}.png`,
      fullPage: true,
    });
  }
  expect(home.errors).toEqual([]);
  expect(home.unexpected).toEqual([]);
});

// DEC-PILOT-ALERTS-BACKUP correction 2: a restaurant on the installation reads about its own Store,
// and nothing it cannot act on. The installation's own Home keeps the test above.
const merchantBoard = {
  audience: "Merchant",
  monitor: "Reporting",
  observedAt: "2026-10-15T16:00:00.000Z",
  active: [],
  recentlyCleared: [],
  outbound: { email: false, webhooks: 0, heartbeat: false },
  lastSuccessfulBackupAt: null,
  plannedUpdate: null,
  checksIncompleteSince: null,
  support: null,
};
const stuckUpdates = {
  key: "payment.updates",
  severity: "critical",
  title: "Order or payment updates are stuck",
  summary:
    "1 update (such as a payment result or an order change) could not be processed after automatic retries (oldest 4 minutes ago).",
  action:
    "Do not take a second payment from guests who say they paid. Check Orders and Exceptions; ask BOP support to review the stuck updates and send them again.",
  raisedAt: "2026-10-15T15:56:00.000Z",
};

test("@production A merchant's Home says nothing about a monitor it cannot start, and keeps its own problems in view", async ({
  page,
}) => {
  let board: unknown = { ...merchantBoard, monitor: "NotRunning", observedAt: null };
  const home = await pilotHome(page, "owner", () => board);
  await page.goto("/app");
  const needs = page.getByRole("region", { name: "Needs attention" });
  const card = page.getByRole("region", { name: "Store system" });
  // What every new merchant's Home said: an urgent row telling a restaurant to ask for the monitor.
  await expect(card.getByText("Store system: not checked yet")).toBeVisible();
  await expect(page.getByText("Store system problems are not being checked")).toHaveCount(0);
  await expect(page.getByText("The alert monitor")).toHaveCount(0);
  await expect(needs.getByText("Urgent", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/backup/iu)).toHaveCount(0);
  await expect(page.getByText(/email or phone alerts/u)).toHaveCount(0);

  // Reporting: the same calm line as any other Store, without the installation's facts.
  board = merchantBoard;
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(card.getByText("Store system: all good")).toBeVisible();
  await expect(card.getByText(/Last checked 12:00/u)).toBeVisible();
  await expect(page.getByText(/backup/iu)).toHaveCount(0);

  // Some of its checks could not run: BOP is told; here it does not say all is good, and the time
  // is when they stopped, not the board's, which moves every minute whether a read worked or not.
  board = { ...merchantBoard, checksIncompleteSince: "2026-10-15T13:05:00.000Z" };
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(card.getByText("Store system: last checked Oct 15, 2026, 9:05 AM")).toBeVisible();
  await expect(card.getByText("all good")).toHaveCount(0);

  // Its own problem: what to do, the page that settles it and who to call.
  board = {
    ...merchantBoard,
    active: [stuckUpdates],
    support: { phone: "+14165550100", testOnly: true },
  };
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(needs.getByText("Order or payment updates are stuck")).toBeVisible();
  await expect(needs.getByRole("link", { name: "Go to Orders" })).toHaveAttribute(
    "href",
    "/operations/orders",
  );
  const call = needs.getByRole("link", { name: "Call BOP support: (416) 555-0100" });
  await expect(call).toHaveAttribute("href", "tel:+14165550100");
  await expect(needs.getByText("(test number)", { exact: false })).toBeVisible();
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(call).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/home-merchant-alerts-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);

  // A day before ordering would stop, because BOP has not renewed: how long, what to do, who to call.
  board = {
    ...merchantBoard,
    active: [
      {
        key: "ordering.ending",
        severity: "critical",
        title: "Ordering at this Store is about to stop",
        summary:
          "When it stops, guests cannot order and staff cannot use the store screens. Only BOP support can renew it.",
        action:
          "Ordering at this Store stops in 23 hours unless BOP support renews it. Call BOP support now. If it stops, keep taking orders on your own POS or on paper, and take payment on the card machine.",
        raisedAt: "2026-10-15T15:56:00.000Z",
      },
    ],
    support: { phone: "+14165550100", testOnly: false },
  };
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(needs.getByText("Ordering at this Store is about to stop")).toBeVisible();
  await expect(needs.getByText("stops in 23 hours", { exact: false })).toBeVisible();
  await expect(needs.getByText("Urgent", { exact: true })).toBeVisible();
  const callNow = needs.getByRole("link", { name: "Call BOP support: (416) 555-0100" });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(callNow).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/home-merchant-ordering-ending-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);

  // The monitor stops with that on the board: staff must not charge that guest again.
  board = { ...merchantBoard, monitor: "Silent", active: [stuckUpdates] };
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(
    needs.getByText("Do not take a second payment from guests who say they paid.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(needs.getByText("Urgent", { exact: true })).toBeVisible();
  await expect(needs.getByText(/as of Oct 15, 2026, 12:00 PM/u)).toBeVisible();
  await expect(page.getByText("The alert monitor")).toHaveCount(0);
  await expect(card.getByText("Store system: needs attention")).toBeVisible();

  // Nothing on the board and no monitor: quiet, and says when it last looked.
  board = { ...merchantBoard, monitor: "Silent" };
  await card.getByRole("button", { name: "Check again" }).click();
  await expect(card.getByText("Store system: last checked Oct 15, 2026, 12:00 PM")).toBeVisible();
  await expect(needs.getByText("Urgent", { exact: true })).toHaveCount(0);
  await expectNoInternalText(page);
  expect(home.errors).toEqual([]);
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
    await expect(page.getByRole("region", { name: "Store system" })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Needs attention" })
        .getByText("Customer ordering page is not loading"),
    ).toBeVisible();
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
  await expect(page.getByText("Customer ordering page is not loading")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Today's summary" })).toHaveCount(0);
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

// WP-2423 item 13 ② (Owner 2026-11-05): while the platform paused the merchant's new guests, every
// staff member sees it on Home with the reason, and what still works.
test("@production Home tells staff the platform paused new guests, and what carries on", async ({
  page,
}) => {
  const home = await pilotHome(page, "front-of-house", () => problem, "Recorded", {
    paused: true,
    since: "2026-11-05T18:00:00.000Z",
    reason: "TEST: account review",
  });
  await page.goto("/app");
  const notice = page.getByRole("region", { name: "New guests" });
  await expect(notice).toContainText("New guests are paused for this restaurant by the platform");
  await expect(notice).toContainText("Reason: TEST: account review");
  await expect(notice).toContainText("Tables already seated and orders already placed carry on");
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
  // Owner 2026-10-18 ("必填（推荐）"): the name is required; the prompt says why and stays until done.
  await expect(
    prompt.getByText(
      "Your store asks every staff member for their name. Orders, refunds and other records show it, so your team can see who did what.",
    ),
  ).toBeVisible();
  await expect(prompt.getByText("This stays here until you add your name.")).toBeVisible();
  await expect(prompt.getByRole("button")).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("region", { name: "Add your name" })).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("region", { name: "Add your name" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/own-name-required-${width}.png` });
  }
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

// AGENTS.md "Warn before timeouts": ordering's last day reaches whoever works the floor, on the
// screen they are working in, from a read that carries only that fact (not the alert board).
const orderingNotice = (page: Page) => page.getByRole("region", { name: "Ordering at this Store" });
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
async function orderingEnding(page: Page, answer: () => unknown) {
  await page.route("**/merchant/ordering-ending", (route) =>
    route.fulfill({ headers, json: answer() }),
  );
}

test("@production a Front of House session on Tables sees ordering stop at 23 hours, not at 25", async ({
  page,
}) => {
  const home = await pilotHome(page, "front-of-house", () => problem);
  // At 25 hours the monitor has written nothing, so that is the server's answer.
  let answer: { endsAt: string | null; support: unknown } = { endsAt: null, support: null };
  await orderingEnding(page, () => answer);
  await page.goto("/operations/dining");
  await expect(page.getByRole("heading", { name: "Tables", exact: true })).toBeVisible();
  await expect(orderingNotice(page)).toHaveCount(0);
  answer = { endsAt: inHours(23.5), support: null };
  await page.reload();
  await expect(page.getByRole("heading", { name: "Tables", exact: true })).toBeVisible();
  await expect(orderingNotice(page)).toContainText("Ordering at this Store stops in 23 hours");
  await expect(orderingNotice(page)).toContainText(
    "Only BOP support can renew it: call them now, or tell your manager.",
  );
  await expect(orderingNotice(page)).toContainText(
    "keep taking orders on your own POS or on paper, and take payment on the card machine",
  );
  // No number configured: no link that goes nowhere.
  await expect(orderingNotice(page).getByRole("link")).toHaveCount(0);
  // This role's board stays closed: it read that one fact, never the alerts.
  expect(home.alertReads).toEqual([]);
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(orderingNotice(page)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/ordering-ending-tables-${width}.png` });
  }
});

test("@production ordering's last day shows on Orders, Pickup and Kitchen, with the number to call", async ({
  page,
}) => {
  await pilotHome(page, "owner", () => problem);
  await orderingEnding(page, () => ({
    endsAt: inHours(3.5),
    support: { phone: "+14165550100", testOnly: true },
  }));
  for (const [path, name] of [
    ["/operations/orders", "orders"],
    ["/operations/pickup", "pickup"],
    ["/operations/kitchen", "kitchen"],
  ] as const) {
    await page.goto(path);
    await expect(orderingNotice(page)).toContainText("Ordering at this Store stops in 3 hours");
    const call = orderingNotice(page).getByRole("link", {
      name: "Call BOP support: (416) 555-0100",
    });
    await expect(call).toHaveAttribute("href", "tel:+14165550100");
    await expect(orderingNotice(page)).toContainText("(test number)");
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(orderingNotice(page)).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `test-results/ordering-ending-${name}-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

test("@production Home: Front of House, who has no row of store system alerts, hears of ordering's last day", async ({
  page,
}) => {
  const staff = await pilotHome(page, "front-of-house", () => problem);
  await orderingEnding(page, () => ({ endsAt: inHours(23.5), support: null }));
  await page.goto("/app");
  await expect(page.getByRole("region", { name: "Right now" })).toBeVisible();
  await expect(orderingNotice(page)).toContainText("Ordering at this Store stops in 23 hours");
  // "Nothing needs attention" would contradict it.
  await expect(page.getByText("Nothing needs attention right now.")).toBeHidden();
  await page.screenshot({ path: "test-results/ordering-ending-home-staff.png" });
  expect(staff.errors).toEqual([]);
  expect(staff.unexpected).toEqual([]);
});

test("@production Home: the Owner reads ordering's last day in Needs attention only", async ({
  page,
}) => {
  const ending = {
    key: "ordering.ending",
    severity: "critical",
    title: "Ordering at this Store is about to stop",
    summary:
      "When it stops, guests cannot order and staff cannot use the store screens. Only BOP support can renew it.",
    action:
      "Ordering at this Store stops in 23 hours unless BOP support renews it. Call BOP support now. If it stops, keep taking orders on your own POS or on paper, and take payment on the card machine.",
    raisedAt: "2026-10-15T15:56:00.000Z",
  };
  await pilotHome(page, "owner", () => ({ ...problem, active: [ending] }));
  await orderingEnding(page, () => ({ endsAt: inHours(23.5), support: null }));
  await page.goto("/app");
  await expect(page.getByText("Ordering at this Store is about to stop")).toBeVisible();
  await expect(orderingNotice(page)).toHaveCount(0);
});

test("@production past the end staff are told it has stopped, in Chinese too", async ({ page }) => {
  await pilotHome(page, "front-of-house", () => problem);
  await orderingEnding(page, () => ({ endsAt: inHours(-1), support: null }));
  await page.goto("/operations/dining");
  await expect(orderingNotice(page)).toContainText("Ordering at this Store has stopped");
  await expect(orderingNotice(page)).not.toContainText("If it stops");
  await page.getByRole("button", { name: "切换到中文" }).click();
  const chinese = page.getByRole("region", { name: "这家店的点单服务" });
  await expect(chinese).toContainText("这家店的点单服务已经停止");
  await expect(chinese).toContainText("继续用店里自己的收银机或纸单点单，用刷卡机收款");
});

test("@production a screen keeps counting down when the read fails, and the notice leaves after a renewal", async ({
  page,
}) => {
  const start = Date.parse("2026-11-25T02:00:00.000Z");
  await page.clock.install({ time: new Date(start) });
  await pilotHome(page, "front-of-house", () => problem);
  let read: "known" | "fails" | "renewed" = "known";
  await page.route("**/merchant/ordering-ending", (route) =>
    read === "fails"
      ? route.fulfill({ status: 503, headers, json: { error: "ordering_ending_unavailable" } })
      : route.fulfill({
          headers,
          json: {
            endsAt: read === "known" ? new Date(start + 3.5 * 3_600_000).toISOString() : null,
            support: null,
          },
        }),
  );
  await page.goto("/operations/dining");
  await expect(orderingNotice(page)).toContainText("stops in 3 hours");
  read = "fails";
  await page.clock.runFor(61 * 60_000);
  await expect(orderingNotice(page)).toContainText("stops in 2 hours");
  read = "renewed";
  await page.clock.runFor(5 * 60_000);
  await expect(orderingNotice(page)).toHaveCount(0);
});
