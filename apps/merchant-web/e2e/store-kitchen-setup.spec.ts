import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * WP-2423 item 11 (Owner 2026-11-01): Store setup → Kitchen. A new Store says guests can't order
 * until its kitchen is set up, one step sets it up, and a dish it can't take is named and fixed;
 * each save survives a reload. Synthetic TEST-ONLY values; the server answers are routed in the
 * browser (the real route is covered by store-kitchen-setup-acceptance).
 */
const id = (n: number) => "018f7716-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const store = id(99);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: store,
};
const headers = { "cache-control": "no-store" };
const setupHref = "/app/organization/stores/" + store + "/setup";

async function session(page: Page) {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-11-01",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "STORE-SETUP",
              label: "Store setup",
              href: setupHref,
              permission: "organization.manage",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/store-setup**", (route) =>
    route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
  );
  await page.route("**/merchant/store/receipt-profile", (route) =>
    route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
  );
}

function kitchen(page: Page, view: { canChange: boolean }) {
  const state = {
    version: 0,
    inEffectFrom: null as string | null,
    uncoveredDishes: [] as string[],
  };
  const saves: Record<string, unknown>[] = [];
  const route = page.route("**/merchant/store/kitchen-setup", async (request) => {
    if (request.request().method() === "POST") {
      const body = request.request().postDataJSON() as Record<string, unknown>;
      saves.push(body);
      state.version += 1;
      state.inEffectFrom = "2026-11-01T15:00:00.000Z";
      state.uncoveredDishes = [];
      await request.fulfill({ headers, json: { status: "Recorded", version: state.version } });
      return;
    }
    await request.fulfill({ headers, json: { ...view, ...state } });
  });
  return { state, saves, route };
}

test("@production a new Store's Owner sets up the kitchen in one step, and it stays after a reload", async ({
  page,
}) => {
  await session(page);
  const { state, saves, route } = kitchen(page, { canChange: true });
  await route;
  await page.goto(setupHref + "#kitchen-setup");

  const panel = page.locator("#kitchen-setup");
  await expect(panel.getByRole("note")).toContainText("Guests can't order at this Store");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await panel.screenshot({ path: `test-results/kitchen-setup-new-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await panel.getByRole("button", { name: "Set up one kitchen line for all dishes" }).click();
  await expect(panel.getByRole("status")).toContainText("The kitchen is set up");
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ expectedVersion: 0 });
  expect(Object.keys(saves[0] ?? {}).sort()).toEqual(["expectedVersion", "operationReference"]);
  await expect(panel).toContainText("Every dish with a recipe can reach the kitchen.");
  await expect(panel).toContainText("Orders already confirmed keep what they got.");
  await expect(panel).toContainText("make it from the Orders page");

  // Reload: read from the server, not the page's memory.
  await page.reload();
  await expect(panel).toContainText("One kitchen line takes this Store's dishes");
  await expect(panel.getByRole("button")).toHaveCount(0);

  // A recipe changed later: the dish is named before an order strands, and fixed here.
  state.uncoveredDishes = ["Synthetic Dumplings · Regular"];
  await page.reload();
  await expect(panel.getByRole("alert")).toContainText("Synthetic Dumplings · Regular");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await panel.screenshot({ path: `test-results/kitchen-setup-dish-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await panel.getByRole("button", { name: "Let the kitchen take these dishes" }).click();
  await expect(panel.getByRole("status")).toContainText("The kitchen now takes these dishes");
  expect(saves[1]).toMatchObject({ expectedVersion: 1 });
  await page.reload();
  await expect(panel).toContainText("Every dish with a recipe can reach the kitchen.");
  await expect(panel.getByRole("alert")).toHaveCount(0);

  const axe = await new AxeBuilder({ page })
    .include("#kitchen-setup")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);
});

test("@production staff who can't change the kitchen see what's missing and who can fix it", async ({
  page,
}) => {
  await session(page);
  const { route } = kitchen(page, { canChange: false });
  await route;
  await page.goto(setupHref);
  const panel = page.locator("#kitchen-setup");
  await expect(panel).toContainText("Guests can't order at this Store");
  await expect(panel).toContainText("Ask the Owner or Store Manager to set this up.");
  await expect(panel.getByRole("button")).toHaveCount(0);
});

test("@production a stale kitchen says so and shows what it is now; a failed read can be retried", async ({
  page,
}) => {
  await session(page);
  let attempts = 0;
  await page.route("**/merchant/store/kitchen-setup", async (request) => {
    if (request.request().method() === "POST") {
      await request.fulfill({ status: 409, headers, json: { error: "kitchen_setup_changed" } });
      return;
    }
    attempts += 1;
    if (attempts === 1) {
      await request.fulfill({ status: 503, headers, json: { error: "unavailable" } });
      return;
    }
    await request.fulfill({
      headers,
      json:
        attempts === 2
          ? { canChange: true, version: 0, inEffectFrom: null, uncoveredDishes: [] }
          : {
              canChange: true,
              version: 1,
              inEffectFrom: "2026-11-01T15:00:00.000Z",
              uncoveredDishes: [],
            },
    });
  });
  await page.goto(setupHref);
  const panel = page.locator("#kitchen-setup");
  await expect(panel.getByRole("alert")).toContainText("Nothing was changed");
  await panel.getByRole("button", { name: "Try again" }).click();
  await panel.getByRole("button", { name: "Set up one kitchen line for all dishes" }).click();
  await expect(panel.getByRole("status")).toContainText("Someone else changed this kitchen");
  await expect(panel).toContainText("One kitchen line takes this Store's dishes");
});
