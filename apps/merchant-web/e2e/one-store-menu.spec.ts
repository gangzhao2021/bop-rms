import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU part 1: a single store's one menu opens as one page —
 * sections and dishes in the guests' order with both names, prices, sold out and hidden; search by
 * either name and filter; sold out today and hide take effect at once; a dragged order is saved to
 * the menu draft. Synthetic, TEST-only data.
 */
const id = (n: number) => "0190996c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const at = "2026-10-28T19:00:00.000Z";
const MENU = id(1);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const sellable = (n: number, name: string, nameZh: string, price: string | null) => ({
  skuReference: id(n),
  skuCode: "SKU_" + n,
  productName: name,
  productNameZh: nameZh,
  sizeName: name,
  active: true,
  priceMinor: price,
  offeredHere: true,
});
let released: string | null = null;
let refuseListing = false;
function builder(version: number, order: number[][]) {
  return {
    screenId: "CAT-MENU-BUILDER",
    sourceAsOf: at,
    viewer: id(50),
    permissions: {
      mayRead: true,
      mayEdit: true,
      maySubmit: true,
      mayApprove: true,
      mayPublish: true,
    },
    menus: [],
    menu: {
      menuReference: MENU,
      internalCode: "MAIN",
      aggregateVersion: version,
      versionReference: id(2),
      name: "TEST menu",
      storeReferences: [scope.storeReference],
      channelCodes: ["CUSTOMER_PWA"],
      orderTypeCodes: ["DINE_IN"],
      sections: [
        {
          sectionReference: id(10),
          code: "DIM",
          name: "Dim sum (TEST)",
          nameZh: "点心",
          items: [],
        },
        {
          sectionReference: id(11),
          code: "NOODLE",
          name: "Noodles (TEST)",
          nameZh: "面",
          items: [],
        },
      ].map((section, index) => ({
        ...section,
        items: (order[index] ?? []).map((n) => ({
          placementReference: id(200 + n),
          skuReference: id(n),
          featured: false,
        })),
      })),
    },
    publication: null,
    latestRelease:
      released === null
        ? null
        : { releaseReference: id(7), sequence: 1, menuVersionReference: released, createdAt: at },
    submittedBy: null,
    soleOperator: null,
    sellables: [
      sellable(30, "Har gow (TEST)", "虾饺", "788"),
      sellable(31, "Siu mai (TEST)", "烧卖", "728"),
      sellable(32, "Dan dan noodles (TEST)", "", "1288"),
      sellable(33, "Beef chow fun (TEST)", "干炒牛河", null),
    ],
    mayOfferHere: true,
    allergenRegistry: false,
    customerView: null,
  };
}
async function session(page: Page) {
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
          businessDate: "2026-10-28",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "CAT-MENU-LIST",
              label: "Menus",
              href: "/app/commerce/menus",
              permission: "catalog.menu.read",
            },
          ],
        },
      },
    }),
  );
}

test("@production a single store's menu on one page: search, filters, sold out, hide and reorder", async ({
  page,
}) => {
  await session(page);
  let version = 3;
  let order = [
    [30, 31],
    [32, 33],
  ];
  const status = new Map<string, string>([[id(33), "NotOffered"]]);
  const menuCommands: Record<string, unknown>[] = [];
  const stockCommands: Record<string, unknown>[] = [];
  await page.route("**/merchant/commerce/menus/query", (route) => {
    const body = route.request().postDataJSON() as { menuReference: string | null };
    if (body.menuReference === null)
      return route.fulfill({
        headers,
        json: {
          screenId: "CAT-MENU-LIST",
          sourceAsOf: at,
          viewer: id(50),
          permissions: builder(version, order).permissions,
          menus: [
            {
              menuReference: MENU,
              internalCode: "MAIN",
              aggregateVersion: version,
              currentVersionReference: id(2),
              localizedNames: { "en-CA": "TEST menu" },
              placements: 4,
              publication: null,
              latestRelease: null,
            },
          ],
        },
      });
    return route.fulfill({ headers, json: builder(version, order) });
  });
  await page.route("**/merchant/commerce/menus/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    menuCommands.push(body);
    if (body.action === "List") {
      if (refuseListing)
        return route.fulfill({ status: 409, headers, json: { error: "NotSingleStore" } });
      released = id(2);
      return route.fulfill({ headers, json: { status: "Listed", menuReference: MENU } });
    }
    const sections = body.sections as { items: { skuReference: string }[] }[] | undefined;
    if (sections)
      order = sections.map((section) =>
        section.items.map((item) => Number.parseInt(item.skuReference.slice(-12), 16)),
      );
    version += 1;
    return route.fulfill({ headers, json: { ok: true } });
  });
  await page.route("**/merchant/commerce/availability/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-AVAILABILITY",
        sourceAsOf: at,
        viewer: id(50),
        timeZone: scope.timeZone,
        permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
        items: [30, 31, 32, 33].map((n) => ({
          skuReference: id(n),
          skuCode: "SKU_" + n,
          productName: "x",
          sizeName: "x",
          status: status.get(id(n)) ?? "Available",
          soldOutUntil: status.get(id(n)) === "SoldOut" ? "2026-10-29T08:00:00.000Z" : null,
        })),
      },
    }),
  );
  await page.route("**/merchant/commerce/availability/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    stockCommands.push(body);
    const sku = String(body.skuReference);
    status.set(
      sku,
      body.action === "SoldOut"
        ? "SoldOut"
        : body.action === "StopOffering"
          ? "NotOffered"
          : "Available",
    );
    return route.fulfill({ headers, json: { ok: true } });
  });

  await page.goto("/app/commerce/menus");
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();
  const dishes = page.locator(".one-menu__dish .one-menu__name");
  await expect(dishes).toHaveText([
    "Har gow (TEST)",
    "Siu mai (TEST)",
    "Dan dan noodles (TEST)",
    "Beef chow fun (TEST)",
  ]);
  await expect(page.getByText("虾饺")).toBeVisible();
  await expect(page.getByText("No Chinese name")).toBeVisible();
  await expect(page.locator(".one-menu__dish").nth(3)).toContainText("No price");
  await expect(page.locator(".one-menu__dish").nth(3)).toContainText("Hidden");
  await expect(
    page.getByText("This menu has not been listed yet.", { exact: false }),
  ).toBeVisible();

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/one-store-menu-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page }).include(".one-menu").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page);

  // Search by either name; filters narrow (and reordering waits until they are cleared).
  await page.getByRole("searchbox", { name: "Search dishes" }).fill("牛");
  await expect(dishes).toHaveText(["Beef chow fun (TEST)"]);
  await expect(page.getByText("Clear the search and filters to reorder dishes.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search dishes" }).fill("");
  await page
    .getByRole("group", { name: "Show only" })
    .getByRole("button", { name: "Missing a name" })
    .click();
  await expect(dishes).toHaveText(["Dan dan noodles (TEST)"]);
  await page
    .getByRole("group", { name: "Show only" })
    .getByRole("button", { name: "Missing a name" })
    .click();

  // Sold out today and hide take effect at once (the Store's item availability).
  await page
    .locator(".one-menu__dish")
    .filter({ hasText: "Siu mai" })
    .getByRole("button", { name: "Sold out today" })
    .click();
  await expect(page.locator(".one-menu__dish").filter({ hasText: "Siu mai" })).toContainText(
    "Sold out today",
  );
  await page
    .getByRole("group", { name: "Show only" })
    .getByRole("button", { name: "Sold out" })
    .click();
  await expect(dishes).toHaveText(["Siu mai (TEST)"]);
  await page
    .getByRole("group", { name: "Show only" })
    .getByRole("button", { name: "Sold out" })
    .click();
  await page
    .locator(".one-menu__dish")
    .filter({ hasText: "Beef chow fun" })
    .getByRole("button", { name: "Show to guests" })
    .click();
  await expect(
    page.locator(".one-menu__dish").filter({ hasText: "Beef chow fun" }).getByRole("button", {
      name: "Hide",
    }),
  ).toBeVisible();
  expect(stockCommands.map((command) => command.action)).toEqual(["SoldOut", "Offer"]);
  expect(stockCommands[0]).toMatchObject({ skuReference: id(31), until: "EndOfDay" });

  // Reorder with the keyboard buttons, then save: the draft gets the new order.
  await page.getByRole("button", { name: "Move Siu mai (TEST) up" }).click();
  await expect(dishes.first()).toHaveText("Siu mai (TEST)");
  await expect(page.getByText("You moved dishes.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Save order" }).click();
  await expect(page.getByText("New order saved.", { exact: false })).toBeVisible();
  expect(menuCommands).toMatchObject([
    {
      action: "SaveDraft",
      menuReference: MENU,
      expectedAggregateVersion: 3,
      sections: [
        { code: "DIM", items: [{ skuReference: id(31) }, { skuReference: id(30) }] },
        { code: "NOODLE", items: [{ skuReference: id(32) }, { skuReference: id(33) }] },
      ],
    },
  ]);
  await expect(dishes.first()).toHaveText("Siu mai (TEST)");

  // WP-2423 item 8 ⑥ part 2: "List it" — no review at a single store.
  refuseListing = true;
  await page.getByRole("button", { name: "List it" }).click();
  await expect(
    page.getByText("This Brand has more than one store, so a menu is reviewed", { exact: false }),
  ).toBeVisible();
  refuseListing = false;
  await page.getByRole("button", { name: "List it" }).click();
  await expect(page.getByText("Listed. Guests see the menu as it is now.")).toBeVisible();
  await expect(page.getByRole("button", { name: "List it" })).toHaveCount(0);
  const listings = menuCommands.filter((command) => command.action === "List");
  expect(listings).toHaveLength(2);
  expect(Object.keys(listings[1] ?? {}).sort()).toEqual([
    "action",
    "menuReference",
    "operationReference",
  ]);
  // A refused listing is finished; the next press is a new listing.
  expect(listings[0]?.operationReference).not.toBe(listings[1]?.operationReference);
});
