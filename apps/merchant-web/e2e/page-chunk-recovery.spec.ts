import { expect, test } from "@playwright/test";

// WP-2423 C2: screens outside the first download load on first use. When a screen's code does
// not arrive (old files gone after a deploy, or dropped Wi-Fi), the app reloads once to pick up
// new files, then shows plain words with "Try again" (a page reload once online, since browsers
// keep a failed module download) instead of a raw error.
test("@production a screen whose code does not arrive reloads once, then offers Try again", async ({
  page,
}) => {
  let blocked = true,
    documents = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents += 1;
  });
  await page.route(/\/assets\/ReportPages-[^/]+\.js$/u, async (route) =>
    blocked ? route.abort("failed") : route.continue(),
  );
  await page.goto("/app/reports");
  await expect(page.getByRole("heading", { name: "This page didn't load" })).toBeVisible({
    timeout: 15_000,
  });
  expect(documents).toBe(2);
  await expect(page.getByText(/PAGE_CHUNK|TypeError|Failed to fetch|import/u)).toHaveCount(0);
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("This device is still offline.", { exact: false })).toBeVisible();
  expect(documents).toBe(2);
  await page.context().setOffline(false);
  blocked = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  expect(documents).toBe(3);
  await expect(page.getByRole("heading", { name: "This page didn't load" })).toHaveCount(0);
});

// v15 run: the workspace links move inside the loaded app. A plain link reloaded the whole app on
// every click, and offline showed the browser's "No internet" page even though the screen had
// already been fetched in the background.
test("@production offline, a workspace link opens an already-fetched screen without reloading the app", async ({
  page,
}) => {
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
    storeReference: "01909985-0000-7000-8000-000000000099",
    timeZone: "America/Toronto",
  };
  let documents = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents += 1;
  });
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-09-19",
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
            {
              screenId: "FUL-PICKUP-QUEUE",
              label: "Pickup",
              href: "/operations/pickup",
              permission: "fulfillment.operate",
            },
          ],
        },
      },
    }),
  );
  const pickupCode = page.waitForResponse(/\/assets\/PickupPages-[^/]+\.js$/u);
  await page.goto("/app");
  const workspace = page.getByRole("navigation", { name: "Workspace" });
  const pickupLink = workspace.locator(".workspace-sidebar__links").getByRole("link", {
    name: "Pickup",
  });
  await expect(pickupLink).toHaveAttribute("href", "/operations/pickup");
  expect((await pickupCode).ok()).toBe(true);
  await page.context().setOffline(true);
  await pickupLink.click();
  await expect(page).toHaveURL(/\/operations\/pickup$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Pickup" })).toBeVisible();
  await expect(pickupLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "This page didn't load" })).toHaveCount(0);
  await workspace.locator(".workspace-sidebar__links").getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/app$/u);
  expect(documents).toBe(1);
  await page.context().setOffline(false);
});

// v15 run (738b4c8b): the Kitchen and Dining pages built their own navigation from plain links,
// so each click reloaded the whole app (and offline showed the browser's "No internet" page).
test("@production the Kitchen and Dining navigation moves between screens without reloading the app", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  let documents = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents += 1;
  });
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
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
          businessDate: "2026-09-19",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "KIT-KITCHEN-QUEUE",
              label: "Kitchen",
              href: "/operations/kitchen",
              permission: "kitchen.operate",
            },
            {
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
            {
              screenId: "FUL-PICKUP-QUEUE",
              label: "Pickup",
              href: "/operations/pickup",
              permission: "fulfillment.operate",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/kitchen/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        operatorStatus: "Unverified",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(6),
        projectedAt: "2026-09-19T12:00:00.000Z",
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        items: [],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({ headers, json: { canOperateTables: true, items: [] } }),
  );
  await page.goto("/operations/kitchen");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  const tables = navigation.getByRole("link", { name: "Tables", exact: true });
  await expect(tables).toHaveAttribute("href", "/operations/dining");
  await expect(navigation.getByRole("link", { name: "Kitchen", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await tables.click();
  await expect(page).toHaveURL(/\/operations\/dining$/u);
  await expect(navigation.getByRole("link", { name: "Tables", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await navigation.getByRole("link", { name: "Kitchen", exact: true }).click();
  await expect(page).toHaveURL(/\/operations\/kitchen$/u);
  await expect(navigation.getByRole("link", { name: "Kitchen", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await navigation.getByRole("link", { name: "Pickup", exact: true }).click();
  await expect(page).toHaveURL(/\/operations\/pickup$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Pickup" })).toBeVisible();
  expect(documents).toBe(1);
});
