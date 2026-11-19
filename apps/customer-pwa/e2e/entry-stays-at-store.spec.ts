import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page, type Request } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// M02 (v15 07b7a1b7): at an installation of several merchants, reloading Lane Dessert's pickup
// page opened DEMO Café (the installation's first Store) and emptied the cart; a reloaded dessert
// table or a closed tea shop did the same. A phone now stays at the Store and table it scanned.
// Synthetic owner answers on the production PWA; the server side (the remembered scan, its
// routing to the scanned Store, the bootstrap's visit) is covered by the API and tooling tests.
test.beforeEach(({ context }) => routeStorefrontReads(context));

const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const LANE = id(0xb);
const DEMO = id(0xa);
const TABLE = id(0x71);
const csrf = "C".repeat(43);
const json = { "content-type": "application/json", "cache-control": "no-store" };
const code = (publicStoreReference: string, publicTableReference: string | null) =>
  "h." +
  Buffer.from(JSON.stringify({ publicStoreReference, publicTableReference })).toString(
    "base64url",
  ) +
  "." +
  Buffer.alloc(64, 7).toString("base64url");
const lanePickup = code(LANE, null);
const laneTable = code(LANE, TABLE);
const demoPickup = code(DEMO, null);
const laneContext = (channel: "Pickup" | "DineIn") => ({
  publicStoreReference: LANE,
  channel,
  locale: "en-CA",
  brandDisplayName: "Lane Brand",
  storeDisplayName: "Lane Dessert",
});
const established = (channel: "Pickup" | "DineIn") => ({
  schemaVersion: 2,
  status: "Established",
  brandDisplayName: "Lane Brand",
  storeDisplayName: "Lane Dessert",
  publicStoreReference: LANE,
  publicTableReference: channel === "DineIn" ? TABLE : null,
  channel,
  operatingState: "Open",
  availableServiceModes: [channel],
  locale: "en-CA",
  contextExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  csrfToken: "N".repeat(43),
});
const notOpen = {
  schemaVersion: 1,
  code: "entry_table_not_open",
  messageKey: "customer.entry.table_not_open",
  recovery: { action: "AskStaff", storeSelection: "Hidden" },
  store: {
    brandDisplayName: "Lane Brand",
    storeDisplayName: "Lane Dessert",
    publicStoreReference: LANE,
    locale: "en-CA",
  },
};

interface Installation {
  /** What the Session bootstrap restores (null: no Session on this browser). */
  bootstrap: Record<string, unknown> | null;
  /** The answer to a replay of this browser's waiting scan (null: nothing waiting). */
  waiting: ((intent: unknown) => { status: number; body: unknown }) | null;
  entries: unknown[];
  pickupRequests: string[];
  /** WP-2423: the "is the table open now?" checks (their bodies), answered from `waiting`. */
  waitChecks: unknown[];
  /** A busy answer for the next checks (seconds to wait), when set. */
  waitBusy: number | null;
  /** That answer: 503 (the store can't say) or 429 (the waiting checks' own budget is spent). */
  waitBusyStatus: 429 | 503;
  /** Batch 33: a fixed answer to every check (a refusal, a passing failure), when set. */
  waitAnswer: { status: number; body: string } | null;
}

/** Two merchants on one installation; the bare pickup address names neither of them. */
async function installation(page: Page, setup: Partial<Installation> = {}) {
  const state: Installation = {
    bootstrap: null,
    waiting: null,
    entries: [],
    pickupRequests: [],
    waitChecks: [],
    waitBusy: null,
    waitBusyStatus: 503,
    waitAnswer: null,
    ...setup,
  };
  await page.route("**/bff/customer/entry/table-wait", (route) => {
    const body = JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>;
    state.waitChecks.push(body);
    if (state.waitAnswer !== null)
      return route.fulfill({
        status: state.waitAnswer.status,
        headers: json,
        body: state.waitAnswer.body,
      });
    if (state.waitBusy !== null)
      return route.fulfill({
        status: state.waitBusyStatus,
        headers: { ...json, "retry-after": String(state.waitBusy) },
        body: JSON.stringify({
          code: state.waitBusyStatus === 429 ? "entry_rate_limited" : "entry_service_unavailable",
        }),
      });
    const answer = state.waiting?.(undefined);
    return route.fulfill({
      headers: json,
      body: JSON.stringify({
        schemaVersion: 1,
        status: answer !== undefined && answer.status === 409 ? "Waiting" : "Changed",
      }),
    });
  });
  await page.route("**/bff/customer/payment-configuration", (route) =>
    route.fulfill({
      headers: json,
      // The pilot hands out its Stores' pickup codes (internalTestEntry, its wire name).
      body: JSON.stringify({
        schemaVersion: 1,
        mode: "stripe",
        publishableKey: "pk_test_SyntheticBrowserOnly",
        returnUrl: "https://synthetic-return.invalid/return",
        wallets: false,
        internalTestEntry: true,
      }),
    }),
  );
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    state.bootstrap === null
      ? route.fulfill({ status: 204, headers: { "cache-control": "no-store" } })
      : route.fulfill({ status: 200, headers: json, body: JSON.stringify(state.bootstrap) }),
  );
  await page.route("**/bff/customer/pickup-entry*", (route) => {
    const url = new URL(route.request().url());
    state.pickupRequests.push(url.search);
    const store = url.searchParams.get("store");
    if (store === LANE)
      return route.fulfill({
        headers: json,
        body: JSON.stringify({ schemaVersion: 1, qrToken: lanePickup }),
      });
    // The bare address names no Store at an installation of several (it named DEMO Café).
    return route.fulfill({
      status: 404,
      headers: json,
      body: JSON.stringify({ code: "PICKUP_ENTRY_UNKNOWN_STORE" }),
    });
  });
  await page.route("**/bff/customer/entry", (route) => {
    const body = JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>;
    state.entries.push(body);
    if (body.resume === true) {
      const answer = state.waiting?.(body.intent);
      return answer === undefined
        ? route.fulfill({
            status: 404,
            headers: json,
            body: JSON.stringify({ code: "CUSTOMER_STORE_NOT_FOUND" }),
          })
        : route.fulfill({
            status: answer.status,
            headers: json,
            body: JSON.stringify(answer.body),
          });
    }
    if (body.qrToken === demoPickup)
      return route.fulfill({
        status: 201,
        headers: json,
        body: JSON.stringify({
          ...established("Pickup"),
          storeDisplayName: "DEMO Café",
          brandDisplayName: "DEMO",
          publicStoreReference: DEMO,
        }),
      });
    if (body.qrToken === laneTable) {
      const answer = state.waiting?.(body.intent) ?? { status: 201, body: established("DineIn") };
      return route.fulfill({
        status: answer.status,
        headers: json,
        body: JSON.stringify(answer.body),
      });
    }
    return route.fulfill({
      status: 201,
      headers: json,
      body: JSON.stringify(established("Pickup")),
    });
  });
  return state;
}

const scannedEntries = (state: Installation) =>
  state.entries.filter((body) => (body as { resume?: unknown }).resume !== true);

/**
 * Batch 33: a check the page clock just fired reaches the routes a moment later; "none was sent"
 * is read after that moment (a quarter second, which the page clock also moves on).
 */
const requestsSettle = (page: Page) => page.waitForTimeout(250);

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

test.describe("@production M02 a phone stays at the Store and table it scanned", () => {
  test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });

  test("a reloaded pickup page stays at Lane Dessert with the same visit: no new entry", async ({
    page,
  }) => {
    const state = await installation(page, {
      bootstrap: { schemaVersion: 1, csrfToken: csrf, menuContext: laneContext("Pickup") },
    });
    for (const load of [() => page.goto("/"), () => page.reload()]) {
      await load();
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: "Ready to order" })).toBeVisible();
      await expect(main).toContainText("Pickup from Lane Dessert is selected.");
      await expect(main.getByRole("button", { name: "Continue ordering" })).toBeVisible();
      await expect(page.getByText("DEMO Café")).toHaveCount(0);
    }
    // The visit (its Session, and the cart bound to it) is never replaced; the bare pickup address
    // is never asked while a visit exists.
    expect(scannedEntries(state)).toEqual([]);
    expect(state.pickupRequests).toEqual([]);
    await expectNoInternalText(page);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: "test-results/m02-pickup-reload-390.png", fullPage: true });
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(page.getByRole("main")).toContainText("已选择在 Lane Dessert 自取");
    await expect(page.getByRole("button", { name: "继续点单" })).toBeVisible();
  });

  test("the bare address with no scan and no visit asks to scan and names no Store", async ({
    page,
  }) => {
    const state = await installation(page);
    await page.goto("/");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Scan the location QR code" })).toBeVisible();
    await expect(page.getByText("DEMO Café")).toHaveCount(0);
    await expect(page.getByText("Lane Dessert")).toHaveCount(0);
    expect(scannedEntries(state)).toEqual([]);
    await expectNoInternalText(page);
    await noHorizontalOverflow(page);
  });

  test("a table not open stays the same table after a reload, and continues once staff open it", async ({
    page,
  }) => {
    await page.clock.install();
    let open = false;
    const state = await installation(page, {
      waiting: () =>
        open ? { status: 201, body: established("DineIn") } : { status: 409, body: notOpen },
    });
    await page.goto("/#qr=" + laneTable);
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: /^This table at .+ isn’t open yet$/u }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/$/u);
    await page.reload();
    await expect(
      main.getByRole("heading", { name: /^This table at .+ isn’t open yet$/u }),
    ).toBeVisible();
    await expect(main).toContainText(
      "This page goes on by itself a few seconds after staff open the table.",
    );
    await expect(page.getByText("DEMO Café")).toHaveCount(0);
    // Staff seat the party; the page checks again by itself and goes on.
    open = true;
    await page.clock.fastForward(3_000);
    await expect(main.getByRole("heading", { name: "Welcome to Lane Dessert" })).toBeVisible();
    // The checks start nothing; the one entry after the table opened does.
    expect(state.entries).toEqual([{ qrToken: laneTable }, { resume: true }, { resume: true }]);
    expect(state.waitChecks).toEqual([{ resume: true }]);
    expect(state.pickupRequests).toEqual([]);
    await noHorizontalOverflow(page);
  });

  // WP-2423 (guest-waits-and-refund-lock, v15 batch 31): after staff pressed Open table the guest's
  // page still said "not open" 20 s and 50 s later and moved on only after about a minute.
  test("staff open the table while the guest waits: the page goes on within a few seconds", async ({
    page,
  }) => {
    await page.clock.install();
    let open = false;
    const state = await installation(page, {
      waiting: () =>
        open ? { status: 201, body: established("DineIn") } : { status: 409, body: notOpen },
    });
    await page.goto("/#qr=" + laneTable);
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: /^This table at .+ isn’t open yet$/u }),
    ).toBeVisible();
    await expect(main.getByRole("status")).toContainText(
      "This page goes on by itself a few seconds after staff open the table.",
    );
    // The guest waits half a minute; the page asks every 3 s, entering nothing. (Each check is
    // answered before the page clock moves on, so the count never depends on the machine's speed.)
    for (let check = 1; check <= 10; check += 1) {
      await page.clock.runFor(3_000);
      await expect.poll(() => state.waitChecks.length).toBe(check);
    }
    // No check between them.
    await page.clock.runFor(2_000);
    expect(state.waitChecks.length).toBe(10);
    expect(state.entries).toEqual([{ qrToken: laneTable }]);
    await expect(main.getByRole("heading", { name: /isn’t open yet$/u })).toBeVisible();
    await page.screenshot({ path: "test-results/b32-table-wait-390.png", fullPage: true });
    // Staff press Open table: at the next check, at most 3 s later, the guest is at the table.
    open = true;
    await page.clock.runFor(1_000);
    await expect(main.getByRole("heading", { name: "Welcome to Lane Dessert" })).toBeVisible();
    expect(state.entries).toEqual([{ qrToken: laneTable }, { qrToken: laneTable }]);
    await expectNoInternalText(page);
  });

  test("a busy store's Retry-After is respected, and after 15 minutes the page says it stopped", async ({
    page,
  }) => {
    await page.clock.install();
    const state = await installation(page, { waiting: () => ({ status: 409, body: notOpen }) });
    await page.goto("/#qr=" + laneTable);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: /isn’t open yet$/u })).toBeVisible();
    state.waitBusy = 40;
    await page.clock.runFor(3_000);
    await expect.poll(() => state.waitChecks.length).toBe(1);
    // Nothing is sent before the 40 seconds the store asked for.
    await page.clock.runFor(39_000);
    expect(state.waitChecks.length).toBe(1);
    state.waitBusy = null;
    await page.clock.runFor(2_000);
    await expect.poll(() => state.waitChecks.length).toBe(2);
    // Still not open after 15 minutes: the page stops and says how to go on.
    const stopped = main.getByText("This page has stopped checking.", { exact: false });
    for (let step = 0; step < 1200 && !(await stopped.isVisible()); step += 1)
      await page.clock.runFor(3_000);
    await expect(main.getByRole("status")).toContainText(
      "This page has stopped checking. Once staff have seated you, tap “We’ve been seated”.",
    );
    const total = state.waitChecks.length;
    expect(total).toBeLessThanOrEqual(80);
    await page.clock.runFor(10 * 60_000);
    expect(state.waitChecks.length).toBe(total);
    await page.screenshot({ path: "test-results/b32-table-wait-stopped-390.png", fullPage: true });
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(main.getByRole("status")).toContainText(
      "这里已停止自动查看。店员带位后，请点“我们已入座”。",
    );
    await page.screenshot({
      path: "test-results/b32-table-wait-stopped-zh-390.png",
      fullPage: true,
    });
    expect(state.entries).toEqual([{ qrToken: laneTable }]);
  });

  // Review (batch 32): a busy room on one Wi-Fi spends the waiting checks' own budget (429 with a
  // Retry-After of up to ten minutes). The page then asks the entry, on the entry's budget, at once
  // and at most once a minute, and "We've been seated" always asks the entry at once.
  test("the waiting checks' budget spent: the page asks the entry instead of waiting minutes", async ({
    page,
  }) => {
    await page.clock.install();
    let open = false;
    const state = await installation(page, {
      waiting: () =>
        open ? { status: 201, body: established("DineIn") } : { status: 409, body: notOpen },
      waitBusy: 600,
      waitBusyStatus: 429,
    });
    await page.goto("/#qr=" + laneTable);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: /isn’t open yet$/u })).toBeVisible();
    // The first check is refused: the page enters once at once instead.
    await page.clock.runFor(3_000);
    await expect.poll(() => state.waitChecks.length).toBe(1);
    await expect.poll(() => state.entries.length).toBe(2);
    // Not again within the minute, and no more waiting checks before the Retry-After.
    await page.clock.runFor(30_000);
    expect(state.waitChecks.length).toBe(1);
    expect(state.entries.length).toBe(2);
    // "We've been seated" asks the entry at once, whatever the waiting checks' budget says.
    await main.getByRole("button", { name: "We’ve been seated" }).click();
    await expect.poll(() => state.entries.length).toBe(3);
    await expect(main.getByRole("heading", { name: /isn’t open yet$/u })).toBeVisible();
    // Staff open the table: the page goes on by itself within the minute.
    open = true;
    const welcome = main.getByRole("heading", { name: "Welcome to Lane Dessert" });
    for (let step = 0; step < 14 && !(await welcome.isVisible()); step += 1)
      await page.clock.runFor(5_000);
    await expect(welcome).toBeVisible();
    expect(state.waitChecks.length).toBe(1);
    expect(state.entries.length).toBe(4);
    await expectNoInternalText(page);
  });

  // Batch 33 (v15 b32 live): the installation answered every waiting check 404
  // CUSTOMER_STORE_NOT_FOUND, the page read that as "the table changed" and entered every 3 s,
  // spending the Store's entry budget (enough waiting phones lock real guests out).
  test("a refused check: the page says the link doesn't work, enters nothing, and 'seated' still asks", async ({
    page,
  }) => {
    await page.clock.install();
    let open = false;
    const state = await installation(page, {
      waiting: () =>
        open ? { status: 201, body: established("DineIn") } : { status: 409, body: notOpen },
      waitAnswer: { status: 404, body: JSON.stringify({ code: "CUSTOMER_STORE_NOT_FOUND" }) },
    });
    await page.goto("/#qr=" + laneTable);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: /isn’t open yet$/u })).toBeVisible();
    await page.clock.runFor(3_000);
    await expect.poll(() => state.waitChecks.length).toBe(1);
    await expect(main.getByRole("status")).toContainText(
      "This link doesn’t work for this table. Ask staff for help. Once staff have seated you, tap “We’ve been seated”.",
    );
    // Nothing more is asked by itself: no check and, above all, no entry.
    await page.clock.runFor(5 * 60_000);
    await requestsSettle(page);
    expect(state.waitChecks.length).toBe(1);
    expect(state.entries).toEqual([{ qrToken: laneTable }]);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: "test-results/b33-table-wait-refused.png", fullPage: true });
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(main.getByRole("status")).toContainText(
      "这个链接打不开这张桌子。请找店员帮忙；店员带位后，请点“我们已入座”。",
    );
    await page.screenshot({
      path: "test-results/b33-table-wait-refused-zh.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "English" }).click();
    // Staff seat them: "We've been seated" asks the entry once and the guest is at the table.
    open = true;
    await main.getByRole("button", { name: "We’ve been seated" }).click();
    await expect(main.getByRole("heading", { name: "Welcome to Lane Dessert" })).toBeVisible();
    expect(state.entries).toEqual([{ qrToken: laneTable }, { qrToken: laneTable }]);
    await expectNoInternalText(page);
  });

  for (const [what, answer] of [
    [
      "an outage of the installation",
      { status: 502, body: JSON.stringify({ code: "INTERNAL_API_UNAVAILABLE" }) },
    ],
    ["an answer the page can't read", { status: 200, body: "<html>proxy</html>" }],
  ] as const)
    test(`a check failing in passing (${what}) waits longer each time and enters nothing`, async ({
      page,
    }) => {
      await page.clock.install();
      const state = await installation(page, {
        waiting: () => ({ status: 409, body: notOpen }),
        waitAnswer: answer,
      });
      await page.goto("/#qr=" + laneTable);
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: /isn’t open yet$/u })).toBeVisible();
      // At 3 s, then 6, 12 and 24 s after each failure.
      for (const [quiet, count] of [
        [3_000, 1],
        [6_000, 2],
        [12_000, 3],
        [24_000, 4],
      ] as const) {
        await page.clock.runFor(quiet - 1_000);
        await requestsSettle(page);
        expect(state.waitChecks.length).toBe(count - 1);
        await page.clock.runFor(1_000);
        await expect.poll(() => state.waitChecks.length).toBe(count);
      }
      expect(state.entries).toEqual([{ qrToken: laneTable }]);
      await expect(main.getByRole("status")).toContainText(
        "This page goes on by itself a few seconds after staff open the table.",
      );
    });

  // Batch 33 (v15 b32 live minor): shown again, the page checked at +50 ms and again at +328 ms.
  test("back in front after a while hidden: one check, then the next one a full step later", async ({
    page,
  }) => {
    await page.clock.install();
    const state = await installation(page, { waiting: () => ({ status: 409, body: notOpen }) });
    await page.goto("/#qr=" + laneTable);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: /isn’t open yet$/u })).toBeVisible();
    const visibility = (shown: boolean) =>
      page.evaluate((visible) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => (visible ? "visible" : "hidden"),
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, shown);
    await page.clock.runFor(3_000);
    await expect.poll(() => state.waitChecks.length).toBe(1);
    await visibility(false);
    await page.clock.runFor(20_000);
    expect(state.waitChecks.length).toBe(1);
    await visibility(true);
    await expect.poll(() => state.waitChecks.length).toBe(2);
    // (Hidden for 20 s, the old timer was due about 1 s after the page came back.)
    await page.clock.runFor(2_000);
    await requestsSettle(page);
    expect(state.waitChecks.length).toBe(2);
    await page.clock.runFor(1_500);
    await expect.poll(() => state.waitChecks.length).toBe(3);
    expect(state.entries).toEqual([{ qrToken: laneTable }]);
  });

  test("'We've been seated' checks again at once", async ({ page }) => {
    let open = false;
    const state = await installation(page, {
      waiting: () =>
        open ? { status: 201, body: established("DineIn") } : { status: 409, body: notOpen },
    });
    await page.goto("/#qr=" + laneTable);
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: /^This table at .+ isn’t open yet$/u }),
    ).toBeVisible();
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(main).toContainText("请让店员带位。店员开台后几秒内，这里会自动继续。");
    await page.getByRole("button", { name: "English" }).click();
    open = true;
    await main.getByRole("button", { name: "We’ve been seated" }).click();
    await expect(main.getByRole("heading", { name: "Welcome to Lane Dessert" })).toBeVisible();
    // The same code again (in memory; it left the address bar at the scan).
    expect(state.entries).toEqual([{ qrToken: laneTable }, { qrToken: laneTable }]);
  });

  test("a guest who joined a table reloads, or scans the same table again, and is welcomed back", async ({
    page,
  }) => {
    const state = await installation(page, {
      bootstrap: {
        schemaVersion: 1,
        csrfToken: csrf,
        menuContext: laneContext("DineIn"),
        visit: { publicTableReference: TABLE, joined: true },
      },
    });
    await page.goto("/");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Welcome to Lane Dessert" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Continue ordering" })).toBeVisible();
    // The table code scanned again (to reopen the menu): the same visit and cart.
    await page.goto("/#qr=" + laneTable);
    await expect(main.getByRole("heading", { name: "Welcome to Lane Dessert" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Continue ordering" })).toBeVisible();
    expect(scannedEntries(state)).toEqual([]);
    await expectNoInternalText(page);
  });

  test("'Order more' after a pickup order starts at Lane Dessert again", async ({ page }) => {
    const orderReference = id(0x99);
    const state = await installation(page, {
      bootstrap: {
        schemaVersion: 1,
        csrfToken: csrf,
        currentOrder: { orderReference, orderNumber: "12", orderType: "Pickup" },
        menuContext: laneContext("Pickup"),
      },
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your order 12", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Order more" }).click();
    // M104: ordering more goes on with this visit, straight back to Lane Dessert's menu.
    await expect(page).toHaveURL(/\/menu$/u);
    await expect(page.getByText("DEMO Café")).toHaveCount(0);
    // The same visit at Lane Dessert: no other Store's code is fetched or scanned.
    expect(state.pickupRequests).toEqual([]);
    expect(scannedEntries(state)).toEqual([]);
  });

  test("a reload on the menu stays at Lane Dessert's menu, never 'which location'", async ({
    page,
  }) => {
    const state = await installation(page, {
      bootstrap: { schemaVersion: 1, csrfToken: csrf, menuContext: laneContext("Pickup") },
    });
    for (const load of [() => page.goto("/menu"), () => page.reload()]) {
      await load();
      await expect(page).toHaveURL(/\/menu$/u);
      await expect(page.getByText("Lane Dessert").first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "Scan the location QR code" })).toHaveCount(0);
      await expect(page.getByText("DEMO Café")).toHaveCount(0);
    }
    expect(scannedEntries(state)).toEqual([]);
    expect(state.pickupRequests).toEqual([]);
    await expectNoInternalText(page);
    await noHorizontalOverflow(page);
  });

  // WP-2423 live minor 26: a reload of the menu opened from "Look at the menu first" (no visit yet)
  // goes back to the scanned table by itself, never "scan the code".
  test("on the menu with no visit yet, a reload goes back to the scanned table", async ({
    page,
  }) => {
    const state = await installation(page, {
      waiting: () => ({ status: 409, body: notOpen }),
    });
    await page.goto("/menu");
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: /^This table at Lane Dessert.* isn’t open yet$/u }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/$/u);
    await expect(main.getByRole("heading", { name: "Scan the location QR code" })).toHaveCount(0);
    await expect(page.getByText("DEMO Café")).toHaveCount(0);
    expect(scannedEntries(state)).toEqual([]);
    expect(state.entries).toEqual([{ resume: true }]);
    expect(state.pickupRequests).toEqual([]);
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(
      main.getByRole("heading", { name: /^Lane Dessert.* 的这桌还没开台$/u }),
    ).toBeVisible();
    await page.getByRole("button", { name: "English" }).click();
    await noHorizontalOverflow(page);
  });

  test("the outage page's Try again comes back with the scanned table code", async ({ page }) => {
    const front = (await import(
      pathToFileURL(path.resolve("../../tooling/environment/pilot-front.mjs")).href
    )) as { renderUnavailable: (head: Buffer, options: { updating: boolean }) => Buffer };
    const state = await installation(page);
    let outage = true;
    const documents: Request[] = [];
    await page.route(
      (url) => url.pathname === "/",
      (route) => {
        if (route.request().resourceType() !== "document") return route.fallback();
        documents.push(route.request());
        if (!outage) return route.fallback();
        outage = false;
        const raw = front
          .renderUnavailable(
            Buffer.from("GET / HTTP/1.1\r\nHost: x\r\nAccept: text/html\r\n\r\n"),
            {
              updating: false,
            },
          )
          .toString("utf8");
        const split = raw.indexOf("\r\n\r\n");
        const headers = Object.fromEntries(
          raw
            .slice(0, split)
            .split("\r\n")
            .slice(1)
            .map((line) => [
              line.slice(0, line.indexOf(":")).toLowerCase(),
              line.slice(line.indexOf(":") + 1).trim(),
            ])
            .filter(([name]) => name !== "content-length" && name !== "connection"),
        );
        return route.fulfill({ status: 503, headers, body: raw.slice(split + 4) });
      },
    );
    await page.goto("/#qr=" + laneTable);
    await expect(
      page.getByRole("heading", { name: "Ordering is paused for a moment" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Try again" }).click();
    await expect(
      page.getByRole("main").getByRole("heading", { name: "Welcome to Lane Dessert" }),
    ).toBeVisible();
    expect(documents).toHaveLength(2);
    expect(scannedEntries(state)).toEqual([{ qrToken: laneTable }]);
  });
});
