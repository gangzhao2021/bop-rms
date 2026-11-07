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
}

/** Two merchants on one installation; the bare pickup address names neither of them. */
async function installation(page: Page, setup: Partial<Installation> = {}) {
  const state: Installation = {
    bootstrap: null,
    waiting: null,
    entries: [],
    pickupRequests: [],
    ...setup,
  };
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
    await expect(main).toContainText("This page continues by itself once the table is open.");
    await expect(page.getByText("DEMO Café")).toHaveCount(0);
    // Staff seat the party; the page checks again by itself and goes on.
    open = true;
    await page.clock.fastForward(20_000);
    await expect(main.getByRole("heading", { name: "Welcome to Lane Dessert" })).toBeVisible();
    expect(state.entries).toEqual([{ qrToken: laneTable }, { resume: true }, { resume: true }]);
    expect(state.pickupRequests).toEqual([]);
    await noHorizontalOverflow(page);
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
    await expect(main).toContainText("请让店员带位，开台后这里会自动继续。");
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

  test("'Start a new order' after a pickup order starts at Lane Dessert again", async ({
    page,
  }) => {
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
    await page.getByRole("button", { name: "Start a new order" }).click();
    const main = page.getByRole("main");
    await expect(main).toContainText("Pickup from Lane Dessert is selected.");
    await expect(page.getByText("DEMO Café")).toHaveCount(0);
    expect(state.pickupRequests).toEqual(["?store=" + LANE]);
    expect(scannedEntries(state)).toEqual([{ qrToken: lanePickup }]);
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
