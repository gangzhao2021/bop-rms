import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

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
    /** Activity answers while a business read holds the Session row (WP-2423 Q18 live defect). */
    activityFailure: null as null | { status: number; error: string },
    /** Deadline reads answer "ended" although the Session is live (must be re-checked). */
    expiryEnded: false,
    /**
     * v15 c9b377cb: this many due writes are skipped because the page's own reads hold the
     * Session row; the server then answers 200 with the unchanged deadlines.
     */
    busyWrites: 0,
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
      if (server.activityFailure)
        return await route.fulfill({
          status: server.activityFailure.status,
          json: { error: server.activityFailure.error },
        });
      const at = await now();
      if (!live(at)) return await route.fulfill({ status: 401, json: { error: "session_ended" } });
      if (at - server.lastSeen >= minute && server.busyWrites > 0) server.busyWrites--;
      else if (at - server.lastSeen >= minute) {
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
      if (server.expiryEnded || !live(at))
        return await route.fulfill({ status: 401, json: { error: "session_ended" } });
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

/**
 * v15 cbff9d6f: the registered tablet's re-check without a sign-in. `waiting` holds the orders still
 * waiting for acceptance (number → deadline); `registered: false` answers like any other browser.
 */
async function tabletRecheck(page: Page, waiting: Record<string, string>, registered = true) {
  const tablet = { calls: 0, asked: [] as string[][], waiting, registered };
  await page.route("**/merchant/staff-switch/refund-recheck", async (route) => {
    tablet.calls++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBeUndefined();
    const { orderNumbers } = route.request().postDataJSON() as { orderNumbers: string[] };
    tablet.asked.push(orderNumbers);
    if (!tablet.registered)
      return route.fulfill({ status: 404, json: { error: "device_not_registered" } });
    const at = await page.evaluate(() => Date.now());
    return route.fulfill({
      headers,
      json: {
        checkedAt: new Date(at).toISOString(),
        orders: orderNumbers.map((orderNumber) => ({
          orderNumber,
          acceptBy: tablet.waiting[orderNumber] ?? null,
        })),
      },
    });
  });
  return tablet;
}

/** Counts the screen's periodic reads that need a sign-in. */
function signedInReads(page: Page) {
  const reads = { count: 0 };
  const watched = new Set([
    "/merchant/orders",
    "/merchant/order-exceptions",
    "/merchant/operations-alerts",
    "/merchant/business-day",
  ]);
  page.on("request", (request) => {
    if (watched.has(new URL(request.url()).pathname)) reads.count++;
  });
  return reads;
}

/** Counts the chime's tones instead of playing them. */
async function countChimes(page: Page) {
  await page.addInitScript(() => {
    const tones = { count: 0 };
    (window as unknown as { __tones: typeof tones }).__tones = tones;
    const ignore = () => undefined;
    const node = () => ({
      connect: (next: unknown) => next ?? node(),
      frequency: { value: 0 },
      gain: { setValueAtTime: ignore, exponentialRampToValueAtTime: ignore },
      type: "sine",
      start: ignore,
      stop: ignore,
    });
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      createOscillator() {
        tones.count += 1;
        return node();
      }
      createGain() {
        return node();
      }
      resume() {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });
  return async () =>
    (await page.evaluate(
      () => (window as unknown as { __tones: { count: number } }).__tones.count,
    )) / 2;
}

/** Home with order 15 waiting for acceptance (refunded at T0 + 8 min); ends the sign-in on cue. */
async function homeWithWaitingOrder(page: Page, entryPath: string) {
  await page.clock.install({ time: T0 });
  await workspace(page, [
    { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
    {
      screenId: "OPS-ORDER-QUEUE",
      label: "Orders",
      href: "/operations/orders",
      permission: "ordering.operate",
    },
  ]);
  await page.route("**/merchant/sign-in-entry", (route) =>
    route.fulfill({
      headers,
      json: { path: entryPath, testOnly: entryPath !== "/operations/switch-staff" },
    }),
  );
  const server = await identity(page);
  const acceptBy = new Date(T0 + 8 * minute).toISOString();
  await page.route("**/merchant/orders", (route) =>
    server.ended
      ? route.fulfill({ status: 401, json: { error: "session_ended" } })
      : route.fulfill({
          headers,
          json: {
            items: [
              {
                orderReference: id(15),
                orderNumber: "15",
                orderType: "Pickup",
                sourceChannel: "Web",
                submittedAt: new Date(T0 - 22 * minute).toISOString(),
                observedAt: new Date(T0).toISOString(),
                initialBatchReference: id(65),
                batches: [
                  {
                    orderBatchReference: id(65),
                    sequence: 1,
                    acceptanceStatus: "NotAccepted",
                    canRequestAcceptance: true,
                    canCancel: false,
                    staffCancellation: null,
                    canCancelItems: false,
                  },
                ],
                canRequestAcceptance: true,
                currentPhase: "Submitted",
                currentVersion: 1,
                unfulfillable: null,
                pickupNotCollected: false,
                acceptBy,
                acceptanceHold: null,
                awaitingPayment: false,
              },
            ],
            nextAfterOrderReference: null,
          },
        }),
  );
  return { server, acceptBy };
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

test("@production Reports and Settlement never sign staff out when an activity report is busy or refused", async ({
  page,
}) => {
  await page.clock.install({ time: T0 });
  await workspace(page, [
    { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
    {
      screenId: "RPT-OPS-DASHBOARD",
      label: "Reports",
      href: "/app/reports/operations",
      permission: "reporting.sales.read",
    },
    {
      screenId: "PAY-RECONCILIATION",
      label: "Settlement",
      href: "/app/operations/payment-reconciliation",
      permission: "operations.order-exception.manage",
    },
  ]);
  const server = await identity(page);
  const signedOut = page.getByRole("dialog", { name: "You’ve been signed out" });
  for (const path of ["/app/reports/operations", "/app/operations/payment-reconciliation"]) {
    // The live defect: the Session row is held by the page's own reads, so activity is refused or
    // reported busy. Staff stay signed in and the page keeps working.
    for (const failure of [
      { status: 503, error: "session_check_unavailable" },
      { status: 403, error: "request_denied" },
    ]) {
      server.activityFailure = failure;
      const before = server.activity;
      await page.goto(path);
      await expect.poll(() => server.activity).toBeGreaterThan(before);
      await advance(page, server, 0);
      await page.mouse.click(5, 5);
      await advance(page, server, 3 * minute);
      expect(server.activity).toBeGreaterThan(before + 1);
      await expect(signedOut).toHaveCount(0);
      await expect(page.getByRole("alert", { name: "Signing out soon" })).toHaveCount(0);
    }
    // Activity says "ended" but a fresh deadline read shows the Session is live: no sign-out.
    server.activityFailure = { status: 401, error: "session_ended" };
    await page.goto(path);
    await expect.poll(() => server.expiry).toBeGreaterThan(0);
    await advance(page, server, 30_000);
    await expect(signedOut).toHaveCount(0);
    server.activityFailure = null;
    // Recovered: the next report records activity again and the page still responds.
    await page.mouse.click(5, 5);
    await advance(page, server, 2 * minute);
    await expect(signedOut).toHaveCount(0);
    await page.getByRole("link", { name: "Home" }).first().click();
    await expect(page).toHaveURL(/\/app$/u);
    await page.goto(path);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(signedOut).toHaveCount(0);
    await noOverflow(page);
  }
});

test("@production a wrongly shown sign-out can be re-checked and leaves the page usable", async ({
  page,
}) => {
  await page.clock.install({ time: T0 });
  await workspace(page, [
    { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
    {
      screenId: "OPS-ORDER-QUEUE",
      label: "Orders",
      href: "/operations/orders",
      permission: "ordering.operate",
    },
  ]);
  const server = await identity(page);
  await page.goto("/app");
  await expect.poll(() => server.activity).toBe(1);
  await advance(page, server, 0);
  // The server answers "ended" for a moment (both reads): the cover appears.
  server.activityFailure = { status: 401, error: "session_ended" };
  server.expiryEnded = true;
  await page.mouse.click(5, 5);
  await advance(page, server, 70_000);
  const signedOut = page.getByRole("dialog", { name: "You’ve been signed out" });
  await expect(signedOut).toBeVisible();
  // The Session is live after all: "Check again" removes the cover and the page works.
  server.activityFailure = null;
  server.expiryEnded = false;
  await signedOut.getByRole("button", { name: "Check again" }).click();
  await expect(signedOut).toHaveCount(0);
  await page.getByRole("link", { name: "Orders" }).first().click();
  await expect(page).toHaveURL(/\/operations\/orders$/u);
});

test("@production using Home extends the idle deadline even when the first reports find the Session busy", async ({
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
  await advance(page, server, 2 * minute);
  // The v15 defect: the report after this tap met the page's own reads every time, the server
  // skipped the write, and the screen still signed out 30 minutes after sign-in.
  server.busyWrites = 2;
  await page.mouse.click(5, 5);
  await advance(page, server, 2 * minute);
  expect(server.busyWrites).toBe(0);
  expect(server.activity).toBeGreaterThanOrEqual(4);
  expect(server.lastSeen).toBeGreaterThan(T0 + 2 * minute);
  expect(server.idle).toBe(server.lastSeen + 30 * minute);
  const reported = server.activity;
  // Nothing else touched: no further reports from Home, and no warning before the new deadline.
  await advance(page, server, 25 * minute + 30_000);
  expect(server.activity).toBe(reported);
  await expect(page.getByRole("alert", { name: "Signing out soon" })).toHaveCount(0);
  // 90 seconds before the moved deadline: warned, still signed in (the old code had signed out).
  await advance(page, server, server.idle - 90_000 - (await page.evaluate(() => Date.now())));
  await expect(page.getByRole("dialog", { name: "You’ve been signed out" })).toHaveCount(0);
  await expect(page.getByRole("alert", { name: "Signing out soon" })).toBeVisible();
});

test("@production an order waiting for acceptance keeps Home signed in, and a sign-out keeps its countdown in view", async ({
  page,
}) => {
  // Counts the chime's tones instead of playing them.
  await page.addInitScript(() => {
    const tones = { count: 0 };
    (window as unknown as { __tones: typeof tones }).__tones = tones;
    const ignore = () => undefined;
    const node = () => ({
      connect: (next: unknown) => next ?? node(),
      frequency: { value: 0 },
      gain: { setValueAtTime: ignore, exponentialRampToValueAtTime: ignore },
      type: "sine",
      start: ignore,
      stop: ignore,
    });
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      createOscillator() {
        tones.count += 1;
        return node();
      }
      createGain() {
        return node();
      }
      resume() {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });
  const chimes = async () =>
    (await page.evaluate(
      () => (window as unknown as { __tones: { count: number } }).__tones.count,
    )) / 2;
  await page.clock.install({ time: T0 });
  await workspace(page, [
    { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
    {
      screenId: "OPS-ORDER-QUEUE",
      label: "Orders",
      href: "/operations/orders",
      permission: "ordering.operate",
    },
  ]);
  // On a registered shared tablet the sign-in is the PIN screen.
  await page.route("**/merchant/sign-in-entry", (route) =>
    route.fulfill({ headers, json: { path: "/operations/switch-staff", testOnly: false } }),
  );
  const server = await identity(page);
  // Order 15: paid, nobody accepted it, refunded automatically at 18:08Z (14:08 in the Store).
  const acceptBy = new Date(T0 + 8 * minute).toISOString();
  // v15 cbff9d6f: this is a registered tablet; with nobody signed in it re-checks order 15 only.
  const tablet = await tabletRecheck(page, { "15": acceptBy });
  const reads = signedInReads(page);
  await page.route("**/merchant/orders", (route) =>
    server.ended
      ? route.fulfill({ status: 401, json: { error: "session_ended" } })
      : route.fulfill({
          headers,
          json: {
            items: [
              {
                orderReference: id(15),
                orderNumber: "15",
                orderType: "Pickup",
                sourceChannel: "Web",
                submittedAt: new Date(T0 - 22 * minute).toISOString(),
                observedAt: new Date(T0).toISOString(),
                initialBatchReference: id(65),
                batches: [
                  {
                    orderBatchReference: id(65),
                    sequence: 1,
                    acceptanceStatus: "NotAccepted",
                    canRequestAcceptance: true,
                    canCancel: false,
                    staffCancellation: null,
                    canCancelItems: false,
                  },
                ],
                canRequestAcceptance: true,
                currentPhase: "Submitted",
                currentVersion: 1,
                unfulfillable: null,
                pickupNotCollected: false,
                acceptBy,
                acceptanceHold: null,
                awaitingPayment: false,
              },
            ],
            nextAfterOrderReference: null,
          },
        }),
  );
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Store" })).toBeVisible();
  await expect.poll(() => server.activity).toBe(1);
  // Nobody touches Home, but an order is waiting: the screen counts as in use (about once a minute).
  await advance(page, server, 3 * minute + 30_000);
  expect(server.activity).toBeGreaterThanOrEqual(4);
  expect(server.idle).toBeGreaterThan(T0 + 32 * minute);
  const warning = page.getByRole("region", { name: "Orders about to be refunded" });
  await expect(warning).toContainText(
    "Order 15 will be refunded automatically in 5 min unless someone accepts it.",
  );
  await expect(warning.getByRole("link", { name: "Accept on Orders" })).toBeVisible();

  // The sign-in ends (signed out on another screen) inside the warning window.
  server.ended = true;
  await advance(page, server, 70_000);
  const signedOut = page.getByRole("dialog", { name: "You’ve been signed out" });
  await expect(signedOut).toBeVisible();
  const kept = signedOut.getByRole("region", { name: "Orders about to be refunded" });
  await expect(kept).toContainText(
    "Order 15 will be refunded automatically in 4 min unless someone accepts it.",
  );
  await expect(kept).toContainText("Sign in to accept it.");
  // Checked again by the tablet after the sign-out (not only "before this screen signed out").
  await expect.poll(() => tablet.calls).toBeGreaterThanOrEqual(1);
  expect(tablet.asked.every((numbers) => numbers.join() === "15")).toBe(true);
  await expect(kept).toContainText(/Last checked at 14:0\d\.$/u);
  // Nothing reads with the ended sign-in any more: no Orders, alerts or business-day polling.
  await advance(page, server, 5_000);
  const readsAtCover = reads.count;
  // No link that cannot work without a sign-in; the cover's own sign-in goes to the PIN screen.
  await expect(kept.getByRole("link")).toHaveCount(0);
  await expect(signedOut.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
    "href",
    "/operations/switch-staff",
  );
  await expect(page.getByRole("region", { name: "Orders about to be refunded" })).toHaveCount(1);
  const onTop = () =>
    page.evaluate(() => {
      const box = document
        .querySelector(".staff-session__cover .refund-deadline-warning li")
        ?.getBoundingClientRect();
      if (!box) return false;
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return top?.closest(".refund-deadline-warning") !== null;
    });
  expect(await onTop()).toBe(true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(kept).toBeVisible();
    expect(await onTop()).toBe(true);
    await noOverflow(page);
    await page.screenshot({ path: `test-results/staff-session-signed-out-refund-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);

  // Two minutes left: the chime sounds only with the words in view on the cover.
  expect(await chimes()).toBe(0);
  await advance(page, server, 2 * minute);
  await expect(kept).toContainText(
    "Order 15 will be refunded automatically in 2 min unless someone accepts it.",
  );
  await expect.poll(chimes).toBe(1);
  expect(await onTop()).toBe(true);
  await expect(signedOut.getByRole("alert").filter({ hasText: "in 2 min" })).toHaveCount(1);
  expect(reads.count).toBe(readsAtCover);
  expect(tablet.calls).toBeGreaterThanOrEqual(8);

  // Sign in again: the PIN screen shows the same countdown (last known, labelled) while the next
  // person enters their PIN.
  await page.route("**/merchant/session", (route) =>
    route.fulfill({ status: 401, json: { error: "session_required" } }),
  );
  await page.route("**/merchant/staff-switch", (route) =>
    route.fulfill({
      headers,
      json: {
        storeLabel: "Synthetic Store",
        timeZone: "America/Toronto",
        staff: [{ choice: "ch-ana", name: "Ana Lopez" }],
        fullSignIn: { path: "/internal-test/staff", testOnly: true },
      },
    }),
  );
  await signedOut.getByRole("link", { name: "Sign in again" }).click();
  await expect(page).toHaveURL(/\/operations\/switch-staff$/u);
  await expect(page.getByRole("button", { name: "Ana Lopez" })).toBeVisible();
  const pinScreen = page.getByRole("region", { name: "Orders about to be refunded" });
  await expect(pinScreen).toContainText(
    "Order 15 will be refunded automatically in 2 min unless someone accepts it.",
  );
  await expect(pinScreen).toContainText("Sign in to accept it.");
  await expect(pinScreen).toContainText(/Last checked at 14:0\d\.$/u);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(pinScreen).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `test-results/staff-switch-refund-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);
  // Past the deadline the remembered countdown is gone; nothing sounds without it.
  await page.clock.runFor(3 * minute);
  await expect(pinScreen).toHaveCount(0);
});

test("@production an order accepted on another screen leaves the signed-out countdown and the PIN screen at once", async ({
  page,
}) => {
  const chimes = await countChimes(page);
  const { server, acceptBy } = await homeWithWaitingOrder(page, "/operations/switch-staff");
  const tablet = await tabletRecheck(page, { "15": acceptBy });
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Store" })).toBeVisible();
  await advance(page, server, 3 * minute + 30_000);
  // Signed out on another screen inside the warning window: the cover keeps the countdown.
  server.ended = true;
  await advance(page, server, 70_000);
  const signedOut = page.getByRole("dialog", { name: "You’ve been signed out" });
  await expect(signedOut).toBeVisible();
  const kept = signedOut.getByRole("region", { name: "Orders about to be refunded" });
  await expect(kept).toContainText("Order 15 will be refunded automatically in 4 min");
  // Someone accepts order 15 at the counter: the next tablet check removes it, nothing sounds.
  delete tablet.waiting["15"];
  await advance(page, server, 16_000);
  await expect(kept).toHaveCount(0);
  await advance(page, server, 2 * minute);
  expect(await chimes()).toBe(0);
  await expect(page.getByRole("region", { name: "Orders about to be refunded" })).toHaveCount(0);
  // The PIN screen remembers the answer, not the old countdown.
  await page.route("**/merchant/session", (route) =>
    route.fulfill({ status: 401, json: { error: "session_required" } }),
  );
  await page.route("**/merchant/staff-switch", (route) =>
    route.fulfill({
      headers,
      json: {
        storeLabel: "Synthetic Store",
        timeZone: "America/Toronto",
        staff: [{ choice: "ch-ana", name: "Ana Lopez" }],
        fullSignIn: { path: "/internal-test/staff", testOnly: true },
      },
    }),
  );
  await signedOut.getByRole("link", { name: "Sign in again" }).click();
  await expect(page.getByRole("button", { name: "Ana Lopez" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Orders about to be refunded" })).toHaveCount(0);
});

test("@production a browser that is not a registered tablet says a signed-out countdown may be out of date and stays silent", async ({
  page,
}) => {
  const chimes = await countChimes(page);
  const { server, acceptBy } = await homeWithWaitingOrder(page, "/internal-test/staff");
  const tablet = await tabletRecheck(page, { "15": acceptBy }, false);
  const reads = signedInReads(page);
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Store" })).toBeVisible();
  await advance(page, server, 3 * minute + 30_000);
  server.ended = true;
  await advance(page, server, 70_000);
  const signedOut = page.getByRole("dialog", { name: "You’ve been signed out" });
  await expect(signedOut).toBeVisible();
  const kept = signedOut.getByRole("region", { name: "Orders about to be refunded" });
  // The last check is more than 30 seconds old and cannot be repeated without a sign-in.
  await expect(kept).toContainText(
    /Order 15 may already have been accepted\. If not, it will be refunded automatically in 4 min\./u,
  );
  await expect(kept).toContainText(
    /Sign in to check\. Last checked at 14:0\d, before this screen signed out\./u,
  );
  await expect(kept).not.toContainText("unless someone accepts it");
  await expect(kept.getByRole("link")).toHaveCount(0);
  // Asked once, told this is no tablet, and never asked again.
  expect(tablet.calls).toBe(1);
  await advance(page, server, 5_000);
  const readsAtCover = reads.count;
  // Past the 2-minute and 30-second points: no chime and no announcement for an order that may
  // already be handled.
  await advance(page, server, 2 * minute + 40_000);
  await expect(kept).toContainText("in less than a minute.");
  expect(await chimes()).toBe(0);
  await expect(signedOut.getByRole("alert").filter({ hasText: "Order 15" })).toHaveCount(0);
  expect(tablet.calls).toBe(1);
  expect(reads.count).toBe(readsAtCover);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(kept).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `test-results/staff-session-signed-out-unsure-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);
});

/** Every request that uses the staff sign-in (all `/merchant/…` but the sign-in plumbing). */
function staffSignInRequests(page: Page) {
  const seen = { count: 0, paths: [] as string[] };
  const plumbing = /^\/merchant\/(?:session(?:\/|$)|sign-in-entry$|logout$|staff-switch(?:\/|$))/u;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/merchant/") && !plumbing.test(path)) {
      seen.count++;
      seen.paths.push(path);
    }
  });
  return seen;
}

/** Home and Orders; Orders answers like the BFF: `403 request_denied` once the sign-in ended. */
async function homeAnsweringLikeTheServer(page: Page) {
  await page.clock.install({ time: T0 });
  await workspace(page, [
    { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
    {
      screenId: "OPS-ORDER-QUEUE",
      label: "Orders",
      href: "/operations/orders",
      permission: "ordering.operate",
    },
  ]);
  const server = await identity(page);
  const orders = { denied: false };
  await page.route("**/merchant/orders", (route) =>
    server.ended || orders.denied
      ? route.fulfill({ status: 403, json: { error: "request_denied" } })
      : route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  return { server, orders };
}

test("@production Switch staff in one tab covers the other tab at once and stops its reads", async ({
  context,
}) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  const a = await homeAnsweringLikeTheServer(tabA);
  const b = await homeAnsweringLikeTheServer(tabB);
  const readsA = staffSignInRequests(tabA);
  await tabA.goto("/app");
  await tabB.goto("/app");
  await expect(tabA.getByRole("heading", { level: 1, name: "Synthetic Store" })).toBeVisible();
  await expect(tabB.getByRole("heading", { level: 1, name: "Synthetic Store" })).toBeVisible();
  await advance(tabA, a.server, 20_000);
  expect(readsA.count).toBeGreaterThan(0);
  const expiryBefore = a.server.expiry;

  await tabB
    .locator(".workspace-sidebar__footer")
    .getByRole("button", { name: "Switch staff" })
    .click();
  await expect(tabB).toHaveURL(/\/internal-test\/staff$/u);
  expect(b.server.loggedOut).toBe(1);
  // Both tabs used the one sign-in cookie of this browser.
  a.server.ended = true;
  // Tab A covers within about two seconds, without waiting for a read or a check of its own.
  const signedOut = tabA.getByRole("dialog", { name: "You’ve been signed out" });
  await expect(signedOut).toBeVisible({ timeout: 2_000 });
  await expect(signedOut).toContainText("signed out here or on another screen");
  expect(a.server.expiry).toBe(expiryBefore);
  const atCover = readsA.count;
  // Nothing in tab A reads with the ended sign-in any more: not Home, not Orders, not alerts.
  await advance(tabA, a.server, 2 * minute);
  expect(readsA.paths.slice(atCover)).toEqual([]);
  // Closing the signed-out tab sends nothing with the sign-in either.
  await tabA.close({ runBeforeUnload: true });
  expect(readsA.paths.slice(atCover)).toEqual([]);
});

test("@production a refused read checks the sign-in at once; a genuine denial does not sign out", async ({
  page,
}) => {
  const { server, orders } = await homeAnsweringLikeTheServer(page);
  const reads = staffSignInRequests(page);
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Store" })).toBeVisible();
  await advance(page, server, 20_000);
  const signedOut = page.getByRole("dialog", { name: "You’ve been signed out" });

  // A genuine permission denial (sign-in still valid): checked, never covered, at most every 30 s.
  const expiryBefore = server.expiry;
  orders.denied = true;
  await advance(page, server, 2 * minute);
  await expect(signedOut).toHaveCount(0);
  const checks = server.expiry - expiryBefore;
  expect(checks).toBeGreaterThanOrEqual(1);
  expect(checks).toBeLessThanOrEqual(5);
  orders.denied = false;
  await advance(page, server, 35_000);

  // Signed out on another device: the next refused read (403, same body) confirms it at once.
  server.ended = true;
  const endedAt = await page.evaluate(() => Date.now());
  let coveredAt: number | null = null;
  for (let waited = 0; waited < 60_000 && coveredAt === null; waited += 1_000) {
    await advance(page, server, 1_000, 1_000);
    if (await signedOut.isVisible()) coveredAt = await page.evaluate(() => Date.now());
  }
  expect(coveredAt).not.toBeNull();
  // Within one 15 s read cycle (plus the check), not at the next routine check a minute later.
  expect((coveredAt ?? 0) - endedAt).toBeLessThanOrEqual(17_000);
  const atCover = reads.count;
  await advance(page, server, 2 * minute);
  expect(reads.paths.slice(atCover)).toEqual([]);
  await expectNoInternalText(page);
});
