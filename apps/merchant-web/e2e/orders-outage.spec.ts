import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * merchant-outage-recovery M102, M100, M43, M42: Orders through a dropped network and a busy
 * spell keeps what it shows, reads again by itself, accepts in place, and remembers its sound.
 */
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
/** A dine-in round waiting for acceptance (no refund deadline), or accepted. */
const round = (n: number, submittedAt: string, accepted: boolean) => ({
  orderReference: id(n),
  orderNumber: "ORD-" + n,
  orderType: "DineIn",
  sourceChannel: "Web",
  submittedAt,
  observedAt: submittedAt,
  initialBatchReference: id(200 + n),
  batches: [
    {
      orderBatchReference: id(200 + n),
      sequence: 1,
      acceptanceStatus: accepted ? "Accepted" : "NotAccepted",
      canRequestAcceptance: !accepted,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: !accepted,
  currentPhase: accepted ? "Accepted" : "Submitted",
  currentVersion: accepted ? 2 : 1,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
});

/** Playwright still runs routes while the context is offline: they answer as the network would. */
const network = { offline: false };
async function open(page: Page, orders: () => unknown[]) {
  await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
  for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
    await page.route(pattern, (route) =>
      network.offline
        ? route.abort("internetdisconnected")
        : route.fulfill({ headers, json: { items: orders(), nextAfterOrderReference: null } }),
    );
}

test("@production offline, Refresh keeps the orders, Accept waits for the network, and the list comes back by itself", async ({
  page,
  context,
}) => {
  let reads = 0;
  await open(page, () => {
    reads += 1;
    return [round(2, "2026-09-14T00:02:00.000Z", false)];
  });
  await page.goto("/operations/orders");
  await expect(page.getByRole("heading", { name: "ORD-2", exact: true })).toBeVisible();
  network.offline = true;
  await context.setOffline(true);
  await page.getByRole("button", { name: "Refresh orders" }).click();
  // The list stays, marked as not refreshed; it never drops to "Loading orders".
  await expect(
    page.getByText("Orders could not be refreshed. Showing the last update", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "ORD-2", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Loading orders" })).toHaveCount(0);
  const accept = page.getByRole("button", { name: "Accept ORD-2", exact: true }).first();
  await expect(accept).toBeDisabled();
  await expect(
    page.getByText("Accept is paused until the connection is back.").first(),
  ).toBeVisible();
  const before = reads;
  network.offline = false;
  await context.setOffline(false);
  // Back online it reads again at once, well inside the 10 s poll.
  await expect.poll(() => reads, { timeout: 4_000 }).toBeGreaterThan(before);
  await expect(
    page.getByText("Orders could not be refreshed. Showing the last update", { exact: false }),
  ).toHaveCount(0);
  await expect(accept).toBeEnabled();
  await expectNoInternalText(page);
});

test("@production a first read with no answer retries by itself", async ({ page }) => {
  let fail = true;
  await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
  await page.route("**/merchant/orders", (route) =>
    fail
      ? route.abort("failed")
      : route.fulfill({
          headers,
          json: {
            items: [round(2, "2026-09-14T00:02:00.000Z", true)],
            nextAfterOrderReference: null,
          },
        }),
  );
  await page.goto("/operations/orders");
  await expect(
    page.getByText("Orders can't be read right now. Retrying on its own", { exact: false }),
  ).toBeVisible();
  fail = false;
  await expect(page.getByRole("heading", { name: "ORD-2", exact: true })).toBeVisible({
    timeout: 8_000,
  });
});

test("@production Accept all accepts each round with its own reference, in place, oldest first", async ({
  page,
}) => {
  const accepted = new Set<number>();
  const bodies: Record<string, unknown>[] = [];
  // The server lists newest first.
  await open(page, () => [
    round(3, "2026-09-14T00:03:00.000Z", accepted.has(3)),
    round(2, "2026-09-14T00:02:00.000Z", accepted.has(2)),
    round(1, "2026-09-14T00:01:00.000Z", accepted.has(1)),
  ]);
  await page.route("**/merchant/orders/accept", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    bodies.push(body);
    const n = [1, 2, 3].find((value) => body.orderReference === id(value)) ?? 0;
    // ORD-2 changed meanwhile (someone else accepted it on another screen).
    if (n === 2)
      return route.fulfill({ status: 409, headers, json: { error: "already_accepted" } });
    accepted.add(n);
    return route.fulfill({ headers, json: { status: "Created", acceptedOrderVersion: 2 } });
  });
  await page.goto("/operations/orders");
  await expect(page.getByRole("heading", { name: "ORD-3", exact: true })).toBeVisible();
  // The longest waiting leads.
  await expect(page.locator("li.order-row h3").first()).toHaveText(/ORD-1/u);
  await page
    .getByRole("group", { name: "Show orders" })
    .getByRole("button", { name: /^To accept/u })
    .click();
  await page.getByRole("button", { name: "Accept all 3" }).click();
  await expect(page.getByText("Accepted 2 of 3 orders.", { exact: false })).toBeVisible();
  await expect(
    page.getByText("ORD-2 changed since it was loaded: check it.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Loading orders" })).toHaveCount(0);
  expect(bodies.map((body) => body.orderReference)).toEqual([id(1), id(2), id(3)]);
  const references = new Set(bodies.map((body) => body.acceptanceReference));
  expect(references.size).toBe(3);
});

test("@production Accept all accepts two waiting rounds of one table, each at the order's version after the last", async ({
  page,
}) => {
  // One dine-in order with rounds 1 and 2 both paid and waiting, plus a second order. The server
  // checks the Order's current version, and every acceptance moves it forward by one.
  let version = 1;
  const acceptedRounds = new Set<string>();
  let otherAccepted = false;
  const bodies: Record<string, unknown>[] = [];
  const table = () => {
    const base = round(1, "2026-09-14T00:01:00.000Z", false);
    const batch = (n: number, sequence: number) => ({
      ...base.batches[0],
      orderBatchReference: id(n),
      sequence,
      acceptanceStatus: acceptedRounds.has(id(n)) ? "Accepted" : "NotAccepted",
      canRequestAcceptance: !acceptedRounds.has(id(n)),
    });
    return {
      ...base,
      batches: [batch(201, 1), batch(202, 2)],
      canRequestAcceptance: acceptedRounds.size < 2,
      currentPhase: acceptedRounds.size === 2 ? "Accepted" : "Submitted",
      currentVersion: version,
    };
  };
  await open(page, () => [round(2, "2026-09-14T00:02:00.000Z", otherAccepted), table()]);
  await page.route("**/merchant/orders/accept", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    bodies.push(body);
    if (body.orderReference === id(2)) {
      otherAccepted = true;
      return route.fulfill({ headers, json: { status: "Created", acceptedOrderVersion: 2 } });
    }
    if (body.expectedOrderVersion !== version)
      return route.fulfill({ status: 409, headers, json: { error: "version_conflict" } });
    version += 1;
    acceptedRounds.add(String(body.orderBatchReference));
    return route.fulfill({ headers, json: { status: "Created", acceptedOrderVersion: version } });
  });
  await page.goto("/operations/orders");
  await expect(page.getByRole("heading", { name: "ORD-2", exact: true })).toBeVisible();
  await page
    .getByRole("group", { name: "Show orders" })
    .getByRole("button", { name: /^To accept/u })
    .click();
  await page.getByRole("button", { name: "Accept all 3" }).click();
  // Counted in orders: one table with two rounds is one order.
  await expect(page.getByText("Accepted all 2 orders.", { exact: true })).toBeVisible();
  await expect(page.getByText("changed since it was loaded", { exact: false })).toHaveCount(0);
  const tableBodies = bodies.filter((body) => body.orderReference === id(1));
  expect(tableBodies.map((body) => body.orderBatchReference)).toEqual([id(201), id(202)]);
  expect(tableBodies.map((body) => body.expectedOrderVersion)).toEqual([1, 2]);
  expect(acceptedRounds.size).toBe(2);
  await expectNoInternalText(page);
});

for (const width of [390, 1024, 1440])
  test(`@production a manager who may also refuse and refund gets Accept all and the row's Accept at ${width}`, async ({
    page,
  }) => {
    // Live v15 2026-11-10: a paid order waiting for acceptance is always cancellable by a manager
    // or owner, so the refusal must not take the plain Accept off the list.
    await page.setViewportSize({ width, height: 900 });
    const accepted = new Set<number>();
    const managed = (n: number, at: string) => {
      const order = round(n, at, accepted.has(n));
      return {
        ...order,
        batches: order.batches.map((batch) => ({
          ...batch,
          canCancel: !accepted.has(n),
        })),
      };
    };
    await open(page, () => [
      managed(2, "2026-09-14T00:02:00.000Z"),
      managed(1, "2026-09-14T00:01:00.000Z"),
    ]);
    await page.route("**/merchant/orders/accept", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      accepted.add([1, 2].find((value) => body.orderReference === id(value)) ?? 0);
      return route.fulfill({ headers, json: { status: "Created", acceptedOrderVersion: 2 } });
    });
    await page.goto("/operations/orders");
    await expect(page.getByRole("heading", { name: "ORD-2", exact: true })).toBeVisible();
    await page
      .getByRole("group", { name: "Show orders" })
      .getByRole("button", { name: /^To accept/u })
      .click();
    for (const n of [1, 2])
      await expect(
        page.getByRole("button", { name: `Accept ORD-${n}`, exact: true }),
      ).toBeVisible();
    await page.getByRole("button", { name: "Accept all 2" }).click();
    await expect(page.getByText("Accepted all 2 orders.", { exact: true })).toBeVisible();
    expect([...accepted].sort()).toEqual([1, 2]);
    await expectNoInternalText(page);
  });

for (const width of [390, 1024, 1440])
  test(`@production Accept all never says the network dropped while every accept is answered, at ${width}`, async ({
    page,
  }) => {
    // v15 2026-11-11: while Accept all ran, and until the list was read again, the first order
    // read "Accept again" and "The network dropped…" although every accept answered 200.
    await page.setViewportSize({ width, height: 900 });
    const accepted = new Set<number>();
    const acceptBy = new Date(Date.now() + 30 * 60_000).toISOString();
    let slowList = false;
    await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
    for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
      await page.route(pattern, async (route) => {
        // The list is read again slowly after the accepts, as on a busy evening.
        if (slowList) await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.fulfill({
          headers,
          json: {
            // Paid pickup orders, each with its time to accept running (as at the Store).
            items: [2, 1].map((n) => ({
              ...round(n, new Date(Date.now() - n * 60_000).toISOString(), accepted.has(n)),
              orderType: "Pickup",
              sourceChannel: "Qr",
              acceptBy: accepted.has(n) ? null : acceptBy,
            })),
            nextAfterOrderReference: null,
          },
        });
      });
    let acceptRequests = 0;
    await page.route("**/merchant/orders/accept", async (route) => {
      acceptRequests += 1;
      slowList = true;
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 600));
      accepted.add([1, 2].find((value) => body.orderReference === id(value)) ?? 0);
      return route.fulfill({ headers, json: { status: "Created", acceptedOrderVersion: 2 } });
    });
    await page.goto("/operations/orders");
    await expect(page.getByRole("heading", { name: "ORD-2", exact: true })).toBeVisible();
    await page
      .getByRole("group", { name: "Show orders" })
      .getByRole("button", { name: /^To accept/u })
      .click();
    await page.getByRole("button", { name: "Accept all 2" }).click();
    // While Accept all sends them, a row's own Accept waits, so no round is sent twice at once.
    const rowAccepts = page.getByRole("button", { name: /^Accept(ing)? ORD-/u });
    await expect(rowAccepts.first()).toBeVisible();
    for (const button of await rowAccepts.all()) await expect(button).toBeDisabled();
    const dropped = page.getByText("The network dropped", { exact: false });
    const again = page.getByRole("button", { name: /^Accept again/u });
    // Looked at as it is at each moment (not waited out): during the accepts, and after the
    // summary until the list has been read again.
    for (let i = 0; i < 12; i++) {
      expect(await dropped.count()).toBe(0);
      expect(await again.count()).toBe(0);
      await page.waitForTimeout(150);
    }
    await expect(page.getByText("Accepted all 2 orders.", { exact: true })).toBeVisible();
    expect(await dropped.count()).toBe(0);
    expect(await again.count()).toBe(0);
    expect([...accepted].sort()).toEqual([1, 2]);
    expect(acceptRequests).toBe(2);
    await expectNoInternalText(page);
  });

test("@production a new order is marked until opened, and sound stays on across a reload", async ({
  page,
}) => {
  let orders = [round(1, "2026-09-14T00:01:00.000Z", false)];
  await page.clock.install();
  await open(page, () => orders);
  await page.goto("/operations/orders");
  await expect(page.getByRole("heading", { name: "ORD-1", exact: true })).toBeVisible();
  await expect(page.getByText("Sound is off. New orders won't ring on this screen.")).toBeVisible();
  await page.getByRole("button", { name: "Turn sound on" }).click();
  await expect(page.getByRole("button", { name: "Sound on" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("li.order-row[data-new]")).toHaveCount(0);
  orders = [round(2, "2026-09-14T00:02:00.000Z", false), ...orders];
  await page.clock.fastForward(11_000);
  const fresh = page.locator("li.order-row[data-new]");
  await expect(fresh).toHaveCount(1);
  await expect(fresh).toContainText("ORD-2");
  await expect(fresh).toContainText("New order");
  await page.getByRole("button", { name: "ORD-2", exact: true }).click();
  await expect(fresh).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "ORD-1", exact: true })).toBeVisible();
  await expect(
    page.getByText("Sound turns back on at your next tap on this screen."),
  ).toBeVisible();
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("button", { name: "Sound on" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
