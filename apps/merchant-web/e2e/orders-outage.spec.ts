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
  await expect(page.getByText("Accepted 2 of 3.", { exact: false })).toBeVisible();
  await expect(
    page.getByText("changed since it was loaded: check it.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Loading orders" })).toHaveCount(0);
  expect(bodies.map((body) => body.orderReference)).toEqual([id(1), id(2), id(3)]);
  const references = new Set(bodies.map((body) => body.acceptanceReference));
  expect(references.size).toBe(3);
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
