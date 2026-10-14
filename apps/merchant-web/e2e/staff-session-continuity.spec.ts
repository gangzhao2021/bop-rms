import { expect, test, type Page } from "@playwright/test";

/**
 * WP-2423 Q18 (DEC-STAFF-SESSION-CONTINUITY): staff stay signed in while they work, are warned
 * before sign-out (idle or the 12-hour limit) with "Stay signed in", and reach a working sign-in
 * once signed out. The routes below model the Identity server rules: activity slides the idle
 * deadline (30 min) at most once a minute, never past the absolute deadline.
 */
const id = (n: number) => "0190b2e0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const T0 = Date.parse("2026-10-14T18:00:00.000Z");
const minute = 60_000;
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const local = (instant: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));

async function workspace(
  page: Page,
  navigation: { screenId: string; label: string; href: string; permission: string }[],
) {
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
          navigation,
        },
      },
    }),
  );
  await page.route("**/merchant/sign-in-entry", (route) =>
    route.fulfill({ headers, json: { path: "/internal-test/staff", testOnly: true } }),
  );
  await page.route("**/internal-test/staff", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>DEMO Staff</title><h1>DEMO Store staff</h1>",
    }),
  );
}

/** The Identity rules for one Session, against the browser's (installed) clock. */
async function identity(page: Page, absoluteAt = T0 + 12 * 60 * minute) {
  const server = {
    lastSeen: T0,
    idle: Math.min(T0 + 30 * minute, absoluteAt),
    absolute: absoluteAt,
    ended: false,
    activity: 0,
    expiry: 0,
    loggedOut: 0,
    pending: 0,
  };
  const now = () => page.evaluate(() => Date.now());
  const body = (at: number) => ({
    idleExpiresAt: new Date(server.idle).toISOString(),
    absoluteExpiresAt: new Date(server.absolute).toISOString(),
    idleTimeoutMinutes: 30,
    serverTime: new Date(at).toISOString(),
  });
  const live = (at: number) => !server.ended && at < Math.min(server.idle, server.absolute);
  await page.route("**/merchant/session/activity", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    server.activity++;
    server.pending++;
    try {
      const at = await now();
      if (!live(at)) return await route.fulfill({ status: 403, json: { error: "request_denied" } });
      if (at - server.lastSeen >= minute) {
        server.lastSeen = at;
        server.idle = Math.min(at + 30 * minute, server.absolute);
      }
      return await route.fulfill({ headers, json: body(at) });
    } finally {
      server.pending--;
    }
  });
  await page.route("**/merchant/session/expiry", async (route) => {
    server.expiry++;
    server.pending++;
    try {
      const at = await now();
      if (!live(at)) return await route.fulfill({ status: 403, json: { error: "request_denied" } });
      return await route.fulfill({ headers, json: body(at) });
    } finally {
      server.pending--;
    }
  });
  await page.route("**/merchant/logout", (route) => {
    server.loggedOut++;
    server.ended = true;
    return route.fulfill({ status: 204 });
  });
  return server;
}

/**
 * Moves the installed clock in steps shorter than the client's 10 s request timeout and lets each
 * session request finish in between, as it would on a real device.
 */
async function advance(page: Page, server: { pending: number }, ms: number, step = 5_000) {
  const settle = async () => {
    for (let tries = 0; server.pending > 0 && tries < 400; tries++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 15));
  };
  await settle();
  for (let done = 0; done < ms; done += step) {
    await page.clock.runFor(Math.min(step, ms - done));
    await settle();
  }
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test("@production an idle screen warns, stays signed in on request, then signs out to a working sign-in", async ({
  page,
}) => {
  await page.clock.install({ time: T0 });
  await workspace(page, [
    { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
  ]);
  const server = await identity(page);
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Store" })).toBeVisible();
  await expect.poll(() => server.activity).toBe(1);
  await advance(page, server, 0);

  // Nobody touches Home for 28.5 minutes: no keep-alive from a screen that is not operational.
  await advance(page, server, 28 * minute + 30_000);
  expect(server.activity).toBe(1);
  const warning = page.getByRole("alert", { name: "Signing out soon" });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(`This screen signs out at ${local(T0 + 30 * minute)} (in 1:`);
  expect(server.expiry).toBeGreaterThanOrEqual(1);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(warning).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `test-results/staff-session-idle-warning-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Stay signed in: one activity report moves the idle deadline 30 minutes on.
  await warning.getByRole("button", { name: "Stay signed in" }).click();
  await expect(warning).toHaveCount(0);
  expect(server.activity).toBe(2);
  expect(server.idle).toBe(server.lastSeen + 30 * minute);
  const stayedAt = server.lastSeen;

  // Unattended again: warned two minutes ahead, then signed out at the idle deadline.
  await advance(page, server, 28 * minute + 10_000);
  await expect(page.getByRole("alert", { name: "Signing out soon" })).toBeVisible();
  await advance(page, server, 2 * minute + 30_000);
  const signedOut = page.getByRole("dialog", { name: "You’ve been signed out" });
  await expect(signedOut).toBeVisible();
  await expect(signedOut).toContainText("signs out after 30 minutes without use");
  expect(server.lastSeen).toBe(stayedAt);
  const signIn = signedOut.getByRole("link", { name: "Sign in again" });
  await expect(signIn).toHaveAttribute("href", "/internal-test/staff");
  await expect(signedOut).toContainText("TEST-ONLY");
  // The signed-out cover hides the staff page underneath.
  expect(
    await page.evaluate(() => {
      const box = document.querySelector("h1")?.getBoundingClientRect();
      if (!box) return false;
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return top?.closest(".staff-session__cover") !== null;
    }),
  ).toBe(true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(signIn).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `test-results/staff-session-signed-out-${width}.png` });
  }
  await signIn.click();
  await expect(page).toHaveURL(/\/internal-test\/staff$/u);
  await expect(page.getByRole("heading", { name: "DEMO Store staff" })).toBeVisible();
});

test("@production a visible order screen keeps the Session alive; a hidden tab does not", async ({
  page,
}) => {
  await page.clock.install({ time: T0 });
  await workspace(page, [
    {
      screenId: "OPS-ORDER-QUEUE",
      label: "Orders",
      href: "/operations/orders",
      permission: "ordering.operate",
    },
  ]);
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  const server = await identity(page);
  await page.goto("/operations/orders");
  await expect.poll(() => server.activity).toBe(1);
  await advance(page, server, 0);
  // 45 minutes on screen with nobody touching it: reported once a minute, never signed out.
  await advance(page, server, 45 * minute);
  expect(server.activity).toBeGreaterThanOrEqual(40);
  expect(server.activity).toBeLessThanOrEqual(47);
  expect(server.idle).toBeGreaterThan(T0 + 70 * minute);
  await expect(page.getByRole("alert", { name: "Signing out soon" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "You’ve been signed out" })).toHaveCount(0);

  // The tab goes to the background: it reports nothing and the Session lapses.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const reported = server.activity;
  await advance(page, server, 35 * minute);
  expect(server.activity).toBe(reported);
  await expect(page.getByRole("dialog", { name: "You’ve been signed out" })).toBeVisible();
});

test("@production the 12-hour limit is explained ahead and Switch staff signs out to the sign-in", async ({
  page,
}) => {
  await page.clock.install({ time: T0 });
  await workspace(page, [
    {
      screenId: "OPS-ORDER-QUEUE",
      label: "Orders",
      href: "/operations/orders",
      permission: "ordering.operate",
    },
  ]);
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  const server = await identity(page, T0 + 9 * minute);
  await page.goto("/operations/orders");
  const ending = page.getByRole("alert", { name: "Sign-in ending" });
  await expect(ending).toBeVisible();
  await expect(ending).toContainText(`Sign in again at ${local(T0 + 9 * minute)}.`);
  await expect(ending).toContainText("staying active does not extend it");
  await expect(ending.getByRole("button", { name: "Stay signed in" })).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(ending).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `test-results/staff-session-absolute-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // The sidebar offers the same Switch staff on a shared tablet.
  await expect(
    page.locator(".workspace-sidebar__footer").getByRole("button", { name: "Switch staff" }),
  ).toBeVisible();
  await ending.getByRole("button", { name: "Switch staff" }).click();
  await expect(page).toHaveURL(/\/internal-test\/staff$/u);
  expect(server.loggedOut).toBe(1);
});

test("@production a signed-out staff page offers the sign-in that works here", async ({ page }) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({ status: 403, json: { error: "request_denied" } }),
  );
  let entry = { path: "/internal-test/staff", testOnly: true };
  await page.route("**/merchant/sign-in-entry", (route) => route.fulfill({ headers, json: entry }));
  await page.goto("/operations/orders");
  const link = page.getByRole("link", { name: "Sign in", exact: true });
  await expect(link).toHaveAttribute("href", "/internal-test/staff");
  await expect(page.getByText("TEST-ONLY", { exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await noOverflow(page);
  }
  // Production: the secure staff sign-in, no test label.
  entry = { path: "/merchant/login?returnTo=/app", testOnly: false };
  await page.goto("/app");
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute(
    "href",
    "/merchant/login?returnTo=/app",
  );
  await expect(page.getByText("TEST-ONLY", { exact: true })).toHaveCount(0);
});
