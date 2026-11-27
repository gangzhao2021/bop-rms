import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * v15 b12 (tables-list-paging, blocker): at Test Merchant 2 (21 tables in use, 30 retired) the
 * Tables read answered 21 tables and a next reference; the screen refused that page, so Tables read
 * "Tables unavailable. Check your connection and refresh." for every staff member and Home said
 * "Could not read: Tables". The server now pages over the tables in use, and every screen reads
 * every page: a Store with many tables lists all of them on Tables and on Home. The old address
 * /app/operations/dining opens Tables, not Home.
 */
const id = (n: number) => "01909970-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "b".repeat(43);

const table = (n: number) => ({
  tableReference: id(0x1000 + n),
  stableLabel: "T" + String(n),
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  blockReasonCode: null,
  aggregateVersion: 2,
  // Every tenth table is seated.
  currentDiningSessionReference: n % 10 === 0 ? id(0x2000 + n) : null,
  elapsedMinutes: n % 10 === 0 ? 25 : null,
  qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
  paymentTiming: "PayLater",
  ...(n % 10 === 0
    ? { session: { phase: "Active", version: 2, orderReference: id(0x3000 + n) } }
    : {}),
  staffRoundsAwaitingPayment: [],
});

/**
 * 130 tables in use: a short first page that points on (as an older server answered), then a full
 * page of 100, then the last 9.
 */
const pages: Record<string, { from: number; to: number; next: string | null }> = {
  first: { from: 1, to: 21, next: id(0x1000 + 21) },
  [id(0x1000 + 21)]: { from: 22, to: 121, next: id(0x1000 + 121) },
  [id(0x1000 + 121)]: { from: 122, to: 130, next: null },
};

async function store(page: Page, screens: readonly [string, string, string][]) {
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Busy Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-13",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: screens.map(([screenId, label, href]) => ({
            screenId,
            label,
            href,
            permission: screenId === "DIN-FLOOR-BOARD" ? "dining.operate" : "merchant.access",
          })),
        },
      },
    }),
  );
  const reads: (string | null)[] = [];
  await page.route("**/merchant/dining/tables", (route) => {
    const query = route.request().postDataJSON() as {
      afterTableReference: string | null;
      limit: number;
    };
    reads.push(query.afterTableReference);
    const slice = pages[query.afterTableReference ?? "first"];
    if (slice === undefined || query.limit !== 100)
      return route.fulfill({ status: 400, headers, json: { error: "invalid" } });
    return route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: true,
        items: Array.from({ length: slice.to - slice.from + 1 }, (_, n) => table(slice.from + n)),
        nextAfterTableReference: slice.next,
      },
    });
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  return reads;
}

const tablesScreen: [string, string, string] = ["DIN-FLOOR-BOARD", "Tables", "/operations/dining"];
const homeScreen: [string, string, string] = ["HOME-OVERVIEW", "Overview", "/app"];

for (const width of [390, 1024, 1440])
  test(`@production Tables lists every table of a Store with many tables at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const reads = await store(page, [homeScreen, tablesScreen]);
    await page.goto("/operations/dining");
    const all = page.getByRole("button", { name: /^All/u }).locator(".table-tabs__count");
    await expect(all).toHaveText("130");
    await expect(
      page.getByRole("button", { name: /^Seated/u }).locator(".table-tabs__count"),
    ).toHaveText("13");
    // A table from the last page is on the floor, in the free tables staff open in one tap.
    await expect(page.getByRole("button", { name: "Select T130", exact: true })).toBeVisible();
    await expect(
      page.getByText("Tables unavailable. Check your connection and refresh."),
    ).toHaveCount(0);
    // Nothing is left to load by hand.
    await expect(page.getByRole("button", { name: "Load more tables" })).toHaveCount(0);
    expect(reads.slice(0, 3)).toEqual([null, id(0x1000 + 21), id(0x1000 + 121)]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoInternalText(page);
    await page.screenshot({ path: `test-results/tables-many-pages-${width}.png` });
  });

test("@production Tables in Chinese lists every page too", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("bop.merchant.language", "zh-Hans");
    } catch {
      /* private window: the default language */
    }
  });
  await store(page, [homeScreen, tablesScreen]);
  await page.goto("/operations/dining");
  await expect(
    page.getByRole("button", { name: /^全部/u }).locator(".table-tabs__count"),
  ).toHaveText("130");
  await expect(page.getByText("桌台暂不可用。请检查网络后刷新。")).toHaveCount(0);
});

test("@production Home reads every page of tables and says nothing is missing", async ({
  page,
}) => {
  const reads = await store(page, [homeScreen, tablesScreen]);
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Synthetic Busy Store" })).toBeVisible();
  const now = page.getByRole("region", { name: "Right now" });
  await expect(now.getByText("Open tables")).toBeVisible();
  await expect.poll(() => reads.length).toBeGreaterThanOrEqual(3);
  await expect(page.getByText(/Could not read/u)).toHaveCount(0);
  await expect(page.getByText("This list may be missing something")).toHaveCount(0);
  expect(reads.slice(0, 3)).toEqual([null, id(0x1000 + 21), id(0x1000 + 121)]);
  await expectNoInternalText(page);
});

test("@production the old address /app/operations/dining opens Tables, not Home", async ({
  page,
}) => {
  await store(page, [homeScreen, tablesScreen]);
  await page.goto("/app/operations/dining");
  await expect(page).toHaveURL(/\/operations\/dining$/u);
  expect(new URL(page.url()).pathname).toBe("/operations/dining");
  await expect(
    page.getByRole("button", { name: /^All/u }).locator(".table-tabs__count"),
  ).toHaveText("130");
  // Any other unknown address still opens Home.
  await page.goto("/app/operations/nothing-here");
  await expect(page).toHaveURL(/\/app$/u);
});
