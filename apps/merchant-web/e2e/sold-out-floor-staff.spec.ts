import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 Q17: Kitchen and Front of House mark an item sold out for today from their own screens and
 * bring it back; they never offer items or mark them sold out until further notice.
 */
const id = (n: number) => "01909a1f-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
const headers = { "cache-control": "no-store" };
const endOfDay = "2026-10-15T04:00:00.000Z";
const nav = (screenId: string, label: string, href: string, permission: string) => ({
  screenId,
  label,
  href,
  permission,
});
const availability = nav(
  "CAT-AVAILABILITY",
  "Item availability",
  "/app/commerce/availability",
  "catalog.sku.read",
);

async function session(page: Page, navigation: readonly unknown[]) {
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
          businessDate: "2026-10-14",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation,
        },
      },
    }),
  );
}

const floorPermissions = { mayOffer: false, mayMarkSoldOut: true, mayMarkUntilBack: false };
async function availabilitySource(page: Page, permissions: object = floorPermissions) {
  const item = (n: number, product: string, size: string, extra: Record<string, unknown>) => ({
    skuReference: id(n),
    skuCode: product.toUpperCase().replaceAll(" ", "-") + "-" + n,
    productName: product,
    sizeName: size,
    status: "Available",
    soldOutUntil: null as string | null,
    ...extra,
  });
  let items = [
    item(1, "Oat latte", "Regular (12 oz)", {}),
    item(2, "Banana bread", "Banana bread", {}),
    item(3, "Seasonal soup", "Bowl", { status: "SoldOut" }),
    item(4, "Catering tray", "Catering tray", { status: "NotOffered" }),
  ];
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/commerce/availability/query", (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-AVAILABILITY",
        sourceAsOf: "2026-10-14T18:00:00.000Z",
        viewer: id(50),
        timeZone: "America/Toronto",
        permissions,
        items,
      },
    });
  });
  await page.route("**/merchant/commerce/availability/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    const sold = body.action === "SoldOut";
    const next = sold
      ? { status: "SoldOut", soldOutUntil: endOfDay }
      : { status: "Available", soldOutUntil: null };
    items = items.map((candidate) =>
      candidate.skuReference === body.skuReference ? { ...candidate, ...next } : candidate,
    );
    return route.fulfill({ headers, json: { status: "Applied", item: next } });
  });
  return commands;
}

async function expectLayout(page: Page, name: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("row", { name: /Oat latte/u })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);
}

test("@production Kitchen marks an item sold out for today from the board and brings it back", async ({
  page,
}) => {
  // 18:00 in Toronto on Oct 14: today's mark ends at the Store's midnight.
  await page.clock.setFixedTime(new Date("2026-10-14T22:00:00.000Z"));
  await session(page, [
    nav("KIT-KITCHEN-QUEUE", "Kitchen", "/operations/kitchen", "kitchen.operate"),
    availability,
  ]);
  await page.route("**/merchant/kitchen/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        operatorStatus: "Unverified",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(6),
        projectedAt: new Date().toISOString(),
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        items: [],
        nextCursor: null,
      },
    }),
  );
  const commands = await availabilitySource(page);

  await page.goto("/operations/kitchen");
  await expect(page.getByRole("heading", { name: "Kitchen", exact: true })).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("link", { name: "Mark an item sold out" })).toBeVisible();
    await page.screenshot({ path: `test-results/sold-out-kitchen-board-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "Mark an item sold out" }).click();
  await expect(page).toHaveURL(/\/app\/commerce\/availability$/u);
  await expect(page.getByText(/Ran out of something\? Mark it sold out/u)).toBeVisible();
  // Only items sold here; no offering and no "until further notice" for floor staff.
  await expect(page.getByRole("row", { name: /Catering tray/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sold out until further notice" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Offer at this Store|Stop offering/u }),
  ).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Seasonal soup/u })).toContainText(
    "Ask a manager to bring it back",
  );
  await expect(page.getByRole("row", { name: /Seasonal soup/u }).getByRole("button")).toHaveCount(
    0,
  );
  // Staff language only: no internal item codes.
  await expect(page.locator("main")).not.toContainText("OAT-LATTE-1");
  // WP-2423: when the list was read, in store time and staff words (v15 showed "Source as of
  // 2026-10-14 22:11"); the text guard now refuses machine dates however they are written.
  await expect(page.locator(".screen-heading")).toContainText("Checked 2:00 PM today");
  await expect(page.locator(".screen-heading")).not.toContainText("Source as of");
  await expectNoInternalText(page);
  await expectLayout(page, "sold-out-kitchen");

  await page
    .getByRole("row", { name: /Oat latte/u })
    .getByRole("button", { name: "Sold out today" })
    .click();
  await expect(page.getByText("Oat latte — Regular (12 oz) is sold out for today.")).toBeVisible();
  // Store time in staff words, never a raw date stamp.
  await expect(page.getByRole("row", { name: /Oat latte/u })).toContainText(
    "Sold out for the rest of today",
  );
  await expect(page.getByRole("row", { name: /Oat latte/u })).not.toContainText("2026-10");
  await page
    .getByRole("row", { name: /Oat latte/u })
    .getByRole("button", { name: "Back in stock" })
    .click();
  await expect(page.getByText("Oat latte — Regular (12 oz) is back in stock.")).toBeVisible();
  expect(commands.map((command) => [command.action, command.until])).toEqual([
    ["SoldOut", "EndOfDay"],
    ["BackInStock", undefined],
  ]);
});

test("@production Front of House reaches sold-out marking from the workspace navigation", async ({
  page,
}) => {
  await session(page, [
    nav("OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"),
    availability,
  ]);
  const commands = await availabilitySource(page);
  await page.goto("/app");
  await page.getByRole("link", { name: "Item availability" }).first().click();
  await expect(page).toHaveURL(/\/app\/commerce\/availability$/u);
  // Plain heading; no internal item codes or screen labels.
  await expect(page.getByRole("heading", { name: "Item availability", level: 2 })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("BANANA-BREAD-2");
  await expect(page.locator("main")).not.toContainText("· Store");
  await expect(page.getByRole("columnheader", { name: /code/iu })).toHaveCount(0);
  await expectLayout(page, "sold-out-front-of-house");
  await page
    .getByRole("row", { name: /Banana bread/u })
    .getByRole("button", { name: "Sold out today" })
    .click();
  await expect(page.getByText("Banana bread is sold out for today.")).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ action: "SoldOut", until: "EndOfDay", skuReference: id(2) });
});

test("@production the kitchen display marks an item sold out for today in its own kitchen frame", async ({
  page,
}) => {
  // The person's roles reach the back office; the kitchen display sign-in still shows the kitchen.
  await session(page, [
    nav("OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"),
    nav("KIT-KITCHEN-QUEUE", "Kitchen", "/operations/kitchen", "kitchen.operate"),
    availability,
  ]);
  await page.route("**/merchant/kitchen/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        operatorStatus: "Named",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(6),
        projectedAt: new Date().toISOString(),
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        items: [],
        nextCursor: null,
      },
    }),
  );
  // The live case: the person behind the kitchen display sign-in is a manager, so the page's own
  // read reports manager permissions; the kitchen display still offers only today's mark.
  const commands = await availabilitySource(page, {
    mayOffer: true,
    mayMarkSoldOut: true,
    mayMarkUntilBack: true,
  });

  await page.goto("/operations/kitchen");
  const kitchenNav = page.getByRole("navigation", { name: "Primary" });
  await expect(kitchenNav.getByRole("link")).toHaveText(["Kitchen", "Mark an item sold out"]);
  await expect(page.getByRole("link", { name: "Orders", exact: true })).toHaveCount(0);
  await kitchenNav.getByRole("link", { name: "Mark an item sold out" }).click();
  await expect(page).toHaveURL(/\/app\/commerce\/availability\?from=kitchen$/u);
  await expect(page.getByText(/Ran out of something\? Mark it sold out/u)).toBeVisible();
  // The kitchen display's header stays: the Store's name and the handover.
  await expect(page.getByRole("heading", { name: scope.storeLabel, level: 1 })).toBeVisible();
  await expect(
    page.locator(".bop-shell__header").getByRole("button", { name: "Hand over / sign out" }),
  ).toBeVisible();
  // Kitchen frame only: no workspace sidebar, no back-office links; the way back to the board.
  await expect(page.getByRole("navigation", { name: "Workspace" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Orders", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", {
      name: "Mark an item sold out",
    }),
  ).toHaveAttribute("aria-current", "page");
  // Today only: no offering and no "until further notice".
  await expect(page.getByRole("button", { name: "Sold out until further notice" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Offer at this Store|Stop offering/u }),
  ).toHaveCount(0);
  await expectLayout(page, "sold-out-kitchen-display");
  await page
    .getByRole("row", { name: /Banana bread/u })
    .getByRole("button", { name: "Sold out today" })
    .click();
  await expect(page.getByText("Banana bread is sold out for today.")).toBeVisible();
  await page
    .getByRole("row", { name: /Banana bread/u })
    .getByRole("button", { name: "Back in stock" })
    .click();
  await expect(page.getByText("Banana bread is back in stock.")).toBeVisible();
  expect(commands.map((command) => [command.action, command.until])).toEqual([
    ["SoldOut", "EndOfDay"],
    ["BackInStock", undefined],
  ]);
  await page.getByRole("link", { name: "Kitchen", exact: true }).click();
  await expect(page).toHaveURL(/\/operations\/kitchen$/u);
  await expect(page.getByRole("heading", { name: "Kitchen", exact: true })).toBeVisible();
});

test("@production WP-2423 v15: an offered item guests see sold out from stock says why, with a way to Orders", async ({
  page,
}) => {
  await session(page, [
    nav("OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"),
    availability,
  ]);
  await page.route("**/merchant/commerce/availability/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-AVAILABILITY",
        sourceAsOf: "2026-10-16T05:40:00.000Z",
        viewer: id(50),
        timeZone: "America/Toronto",
        permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
        items: [
          {
            skuReference: id(1),
            skuCode: "OAT-LATTE-1",
            productName: "Oat latte",
            sizeName: "Regular (12 oz)",
            status: "Available",
            soldOutUntil: null,
            stockSoldOut: {
              ingredients: [
                {
                  name: "Whole milk 3.25%",
                  unitCode: "L",
                  displayPrecision: 3,
                  required: "0.24",
                  onHand: "2.8",
                  reserved: "2.8",
                  available: "0",
                  openOrderCount: 11,
                },
              ],
            },
          },
          {
            skuReference: id(2),
            skuCode: "BANANA-BREAD-2",
            productName: "Banana bread",
            sizeName: "Banana bread",
            status: "Available",
            soldOutUntil: null,
            stockSoldOut: null,
          },
        ],
      },
    }),
  );
  await page.goto("/app/commerce/availability");
  const latte = page.getByRole("row", { name: /Oat latte/u });
  await expect(latte).toContainText("Sold out to guests (stock)");
  await expect(latte).toContainText(
    "All 2.8 L of Whole milk 3.25% is set aside for 11 open orders.",
  );
  await expect(latte.getByRole("link", { name: "See Orders" })).toHaveAttribute(
    "href",
    /\/operations\/orders$/u,
  );
  await expect(page.getByRole("row", { name: /Banana bread/u })).toContainText("Available");
  await expectNoInternalText(page);
  await expectLayout(page, "availability-stock-reason");
});
