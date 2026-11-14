import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 M61: a shared tablet signed in with a PIN returns to the staff list after five minutes
 * nobody touched it, even on Orders (which keeps the sign-in alive on its own). The staff list then
 * keeps warning about paid orders at the Store, a new one placed after the return included. A
 * sign-out that cannot reach the server leaves the old sign-in ended in this browser: Back or a
 * link never resumes it, and the sign-out is retried.
 */
const id = (n: number) => "0190b2e0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const T0 = Date.parse("2026-10-14T18:00:00.000Z");
const minute = 60_000;
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};

async function tablet(page: Page) {
  const state = {
    signedIn: true,
    logoutOk: true,
    logouts: 0,
    waiting: {} as Record<string, string>,
    asked: [] as string[][],
  };
  await page.route("**/merchant/session", (route) =>
    state.signedIn
      ? route.fulfill({
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
                  screenId: "HOME-OVERVIEW",
                  label: "Overview",
                  href: "/app",
                  permission: "merchant.access",
                },
                {
                  screenId: "OPS-ORDER-QUEUE",
                  label: "Orders",
                  href: "/operations/orders",
                  permission: "ordering.operate",
                },
              ],
            },
          },
        })
      : route.fulfill({ status: 401, json: { error: "session_required" } }),
  );
  await page.route("**/merchant/sign-in-entry", (route) =>
    route.fulfill({ headers, json: { path: "/operations/switch-staff", testOnly: false } }),
  );
  const deadlines = async () => {
    const at = await page.evaluate(() => Date.now());
    return {
      idleExpiresAt: new Date(at + 30 * minute).toISOString(),
      absoluteExpiresAt: new Date(T0 + 12 * 60 * minute).toISOString(),
      idleTimeoutMinutes: 30,
      serverTime: new Date(at).toISOString(),
    };
  };
  for (const path of ["**/merchant/session/activity", "**/merchant/session/expiry"])
    await page.route(path, async (route) =>
      state.signedIn
        ? route.fulfill({ headers, json: await deadlines() })
        : route.fulfill({ status: 401, json: { error: "session_ended" } }),
    );
  await page.route("**/merchant/logout", (route) => {
    state.logouts++;
    if (!state.logoutOk) return route.abort("internetdisconnected");
    state.signedIn = false;
    return route.fulfill({ status: 204 });
  });
  await page.route("**/merchant/staff-pin", (route) =>
    route.fulfill({
      headers,
      json: {
        pin: { state: "Set", changedAt: null, lockedUntil: null },
        signIn: "Pin",
        verifiedUntil: null,
        tabletIdleReturnMinutes: 5,
      },
    }),
  );
  await page.route("**/merchant/organization/staff/me", (route) =>
    route.fulfill({ headers, json: { name: "Recorded", displayName: "Sam" } }),
  );
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/staff-switch", (route) =>
    route.fulfill({
      headers,
      json: {
        storeLabel: "Synthetic Store",
        timeZone: "America/Toronto",
        staff: [
          { choice: "ch-ana", name: "Ana Lopez", lockedUntil: null },
          { choice: "ch-sam", name: "Sam", lockedUntil: null },
        ],
        fullSignIn: { path: "/internal-test/staff", testOnly: true },
      },
    }),
  );
  // The registered tablet's check without a sign-in: the asked orders, then every other paid
  // order waiting at the Store (numbers and times only).
  await page.route("**/merchant/staff-switch/refund-recheck", async (route) => {
    const { orderNumbers } = route.request().postDataJSON() as { orderNumbers: string[] };
    state.asked.push(orderNumbers);
    const at = await page.evaluate(() => Date.now());
    return route.fulfill({
      headers,
      json: {
        checkedAt: new Date(at).toISOString(),
        orders: [
          ...orderNumbers.map((orderNumber) => ({
            orderNumber,
            acceptBy: state.waiting[orderNumber] ?? null,
          })),
          ...Object.entries(state.waiting)
            .filter(([orderNumber]) => !orderNumbers.includes(orderNumber))
            .map(([orderNumber, acceptBy]) => ({ orderNumber, acceptBy })),
        ],
      },
    });
  });
  return state;
}

async function advance(page: Page, ms: number, step = 5_000) {
  for (let done = 0; done < ms; done += step) {
    await page.clock.runFor(Math.min(step, ms - done));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("@production an unused shared tablet returns to the staff list, which still warns about a new paid order", async ({
  page,
}) => {
  await page.clock.install({ time: T0 });
  const state = await tablet(page);
  await page.goto("/operations/orders");
  // Who is signed in on this screen is in the frame.
  await expect(
    page.locator(".workspace-sidebar__footer").getByText("Sam · signed in with PIN"),
  ).toBeVisible();
  // Orders keeps the sign-in alive by itself, but nobody touches the tablet for four and a half
  // minutes: a bar says it will return to the staff list.
  await advance(page, 4 * minute + 31_000);
  const bar = page.getByRole("alert", { name: "Returning to the staff list" });
  await expect(bar).toContainText("so the next person signs in as themselves");
  await expect(bar).toContainText(/Returning to the staff list in 0:[0-2]\d/u);
  await expectNoInternalText(page);
  // A tap keeps working.
  await page.mouse.click(700, 600);
  await advance(page, 5_000);
  await expect(bar).toHaveCount(0);
  // Then nobody again: at five minutes it signs out and opens the staff list.
  await advance(page, 5 * minute + 5_000);
  await expect(page).toHaveURL(/\/operations\/switch-staff$/u);
  expect(state.logouts).toBe(1);
  await expect(page.getByRole("button", { name: "Ana Lopez" })).toBeVisible();
  // A guest pays for pickup order 21 after everyone left the tablet: the staff list shows it
  // with its countdown, though this tablet never knew it.
  // (Warnings start five minutes before the refund.)
  state.waiting["21"] = new Date(
    (await page.evaluate(() => Date.now())) + 4 * minute,
  ).toISOString();
  await advance(page, 20_000);
  const warning = page.getByRole("region", { name: "Orders about to be refunded" });
  await expect(warning).toContainText(
    /Order 21 will be refunded automatically in [34] min unless someone accepts it\./u,
  );
  await expect(warning).toContainText("Sign in to accept it.");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(warning).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/staff-idle-return-${width}.png` });
  }
});

for (const width of [390, 1024, 1440])
  test(`@production the staff list shows a paid order waiting long before its refund at ${width}`, async ({
    page,
  }) => {
    // Live v15 2026-11-10: order 29 was paid with 30 minutes to accept, and the tablet's staff
    // list said nothing for 25 of them. Nobody signed in there sees Orders.
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.clock.install({ time: T0 });
    const state = await tablet(page);
    state.waiting["29"] = new Date(T0 + 28 * minute).toISOString();
    await page.goto("/operations/switch-staff");
    await expect(page.getByRole("button", { name: "Ana Lopez" })).toBeVisible();
    const waiting = page.getByRole("region", { name: "Paid orders waiting to be accepted" });
    await expect(waiting).toContainText(
      "Order 29 is paid and waiting to be accepted. It will be refunded automatically in 28 min unless someone accepts it.",
    );
    await expect(waiting).toContainText("Sign in to accept it.");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/staff-list-waiting-${width}.png` });
    // In its last five minutes it turns into the usual countdown.
    await advance(page, 24 * minute);
    await expect(page.getByRole("region", { name: "Orders about to be refunded" })).toContainText(
      "Order 29 will be refunded automatically in 4 min unless someone accepts it.",
    );
    await expectNoInternalText(page);
  });

test("@production a return that cannot reach the server never lets Back resume the previous person", async ({
  page,
}) => {
  await page.clock.install({ time: T0 });
  const state = await tablet(page);
  state.logoutOk = false;
  await page.goto("/operations/orders");
  await expect(
    page.locator(".workspace-sidebar__footer").getByText("Sam · signed in with PIN"),
  ).toBeVisible();
  await advance(page, 5 * minute + 5_000);
  await expect(page).toHaveURL(/\/operations\/switch-staff$/u);
  // The server still holds Sam's sign-in (the sign-out never arrived). Back to Orders:
  await page.goBack();
  await expect(page).toHaveURL(/\/operations\/orders$/u);
  await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
  await expect(page.getByText("Sam · signed in with PIN")).toHaveCount(0);
  // The sign-out is retried until it goes through (here when the network is back).
  const before = state.logouts;
  state.logoutOk = true;
  await advance(page, 35_000);
  expect(state.logouts).toBeGreaterThan(before);
  expect(state.signedIn).toBe(false);
});
