import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 (v15 batch 5, menu-authoring-prices), at a Brand with several Stores: a dish's price
 * saved "Only at this Store" says guests here pay it from now (and that nothing else waits for
 * "List it"); a save whose answer the dropped network lost goes again unchanged as the same save;
 * "What goes live" names each extra price and every new dish at each other Store, with a count. 1440,
 * 1024 and 390 wide. Synthetic, TEST-only data.
 */
const id = (n: number) => "0190996c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const at = "2026-10-28T19:00:00.000Z";
const MENU = id(1);
const tax = id(75);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store 2",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const sellable = (n: number, name: string, nameZh: string, price: string) => ({
  skuReference: id(n),
  skuCode: "SKU_" + n,
  productName: name,
  productNameZh: nameZh,
  sizeName: name,
  active: true,
  priceMinor: price,
  brandPriceMinor: price,
  storePriceMinor: null as string | null,
  pendingBrandPriceMinor: null,
  pendingPriceMinor: null,
  offeredHere: true,
  productReference: id(n + 100),
  allergensAnswered: true,
  allergens: { source: "StaffDeclared", declared: [], noIngredients: true },
});
function view(listed: boolean, own: string | null, review: Record<string, unknown> = {}) {
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
      aggregateVersion: 3,
      versionReference: id(2),
      name: "TEST menu",
      storeReferences: [scope.storeReference, id(98)],
      channelCodes: ["CUSTOMER_PWA"],
      orderTypeCodes: ["DINE_IN"],
      sections: [
        {
          sectionReference: id(10),
          code: "NOODLE",
          name: "Noodles (TEST)",
          nameZh: "面",
          items: [30, 32].map((n) => ({
            placementReference: id(200 + n),
            skuReference: id(n),
            featured: false,
          })),
        },
      ],
    },
    publication: null,
    latestRelease: {
      releaseReference: id(7),
      sequence: 1,
      menuVersionReference: id(2),
      createdAt: at,
    },
    listingStep: listed ? "Listed" : "Submit",
    submittedBy: null,
    soleOperator: null,
    stores: { severalStores: true, servesHere: true },
    pricePowers: { severalStores: true, mayAllStores: true, mayThisStore: true },
    sellables: [
      sellable(30, "Har gow (TEST)", "虾饺", "788"),
      {
        ...sellable(32, "Dan dan noodles (TEST)", "担担面", "1288"),
        priceMinor: own ?? "1288",
        storePriceMinor: own,
      },
    ],
    mayOfferHere: true,
    allergenRegistry: false,
    customerView: null,
    priceDraft: null,
    priceChangesOnPricesPage: 0,
    choicePriceChanges: [],
    otherStores: { storeCount: 1, notDecided: [], listingOffers: true },
    ...review,
  };
}
async function session(page: Page) {
  // No combos unless a test makes one (WP-2423 item 8 ⑥ part 4).
  await page.route("**/merchant/commerce/one-store-combos/query", (route) =>
    route.fulfill({ headers, json: { combos: [] } }),
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

async function routes(page: Page, menu: () => unknown) {
  await session(page);
  await page.route("**/merchant/commerce/menus/query", (route) => {
    const body = route.request().postDataJSON() as { menuReference: string | null };
    if (body.menuReference !== null) return route.fulfill({ headers, json: menu() });
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-MENU-LIST",
        sourceAsOf: at,
        viewer: id(50),
        permissions: view(true, null).permissions,
        menus: [
          {
            menuReference: MENU,
            internalCode: "MAIN",
            aggregateVersion: 3,
            currentVersionReference: id(2),
            localizedNames: { "en-CA": "TEST menu" },
            placements: 2,
            publication: null,
            latestRelease: null,
          },
        ],
      },
    });
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
        items: [30, 32].map((n) => ({
          skuReference: id(n),
          skuCode: "SKU_" + n,
          productName: "x",
          sizeName: "x",
          status: "Available",
          soldOutUntil: null,
        })),
      },
    }),
  );
  for (const path of ["kitchen-not-prepared", "kitchen-sections"])
    await page.route(`**/merchant/commerce/${path}/command`, (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const products = (body.productReferences as string[] | undefined) ?? [];
      return route.fulfill({
        headers,
        json: {
          version: 1,
          sections: [],
          products: products.map((productReference) => ({
            productReference,
            sectionReference: null,
            notPrepared: false,
            version: 0,
          })),
        },
      });
    });
  await page.route("**/merchant/commerce/products/query", (route) => {
    const body = route.request().postDataJSON() as { productReference: string | null };
    const sku = Number.parseInt(String(body.productReference).slice(-12), 16) - 100;
    const name = sku === 30 ? "Har gow (TEST)" : "Dan dan noodles (TEST)";
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-PRODUCT-DETAIL",
        sourceAsOf: at,
        locale: "en-CA",
        permissions: {},
        productTypes: [],
        sellingUnits: [],
        taxClasses: [
          {
            taxClassificationReference: tax,
            rules: [
              {
                orderType: "DineIn",
                taxComponentCode: "TEST_TAX",
                treatment: "Taxable",
                rate: "0.13",
                priceInclusion: "Exclusive",
              },
            ],
          },
        ],
        optionSetChoices: [],
        product: {
          productReference: body.productReference,
          name,
          nameZh: "",
          taxClassificationReference: tax,
          sizes: [{ skuReference: id(sku), skuCode: "SKU_" + sku, name, nameZh: "" }],
          optionSets: [],
          presentation: { description: "", descriptionZh: "", photo: null },
        },
      },
    });
  });
  await page.route("**/merchant/commerce/option-prices/query", (route) =>
    route.fulfill({ headers, json: { screenId: "PRICE-OPTION-LIST", products: [] } }),
  );
}
const noSideScroll = async (page: Page, name: string) => {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};

test("@production a price saved only at this Store says guests pay it now, and a lost answer is saved again as it was", async ({
  page,
}) => {
  let own: string | null = null;
  await routes(page, () => view(true, own));
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/commerce/one-store-dishes/command", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    // The first save is applied, but its answer never arrives.
    if (sent.length === 1) {
      own = String(body.priceMinor);
      return route.abort("failed");
    }
    own = String(body.priceMinor);
    return route.fulfill({
      headers,
      json: {
        status: "Saved",
        productReference: body.productReference,
        choicesWaiting: false,
        price: { brandPriceMinor: "1288", pendingBrandPriceMinor: null, storePriceMinor: own },
        listingNeeded: false,
      },
    });
  });
  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "Edit Dan dan noodles (TEST) 担担面" }).click();
  const editor = page.getByRole("form", { name: "Dan dan noodles (TEST) 担担面" });
  await editor.getByLabel("Price here ($)").fill("13.50");
  await editor.getByLabel("Only at this Store — changes now").check();
  await noSideScroll(page, "store-price-editor");
  const axe = await new AxeBuilder({ page }).include(".one-menu").analyze();
  expect(axe.violations).toEqual([]);
  await editor.getByRole("button", { name: "Save dish" }).click();
  await expect(editor.getByText("The network dropped", { exact: false })).toBeVisible();
  // Nothing touched: Save dish again sends the same save, as it was sent.
  await editor.getByRole("button", { name: "Save dish" }).click();
  await expect(
    page.getByText(
      "Dan dan noodles (TEST): guests at this Store pay $13.50 from now. Nothing else changed, so there is nothing to list.",
    ),
  ).toBeVisible();
  await expect(page.getByText("This form changed after saving stopped")).toHaveCount(0);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[1]).toMatchObject({
    priceMinor: "1350",
    priceScope: "ThisStore",
    expectedPriceMinor: "1288",
  });
  await noSideScroll(page, "store-price-saved");
  await expectNoInternalText(page);
});

test("@production b9: what saving a dish far down a long menu did is said at that dish, in view", async ({
  page,
}) => {
  let own: string | null = null;
  // Thirty dishes before it, so the dish is far below the top of the page at every width.
  const many = Array.from({ length: 30 }, (_, index) => 400 + index);
  const longMenu = () => {
    const read = view(true, own);
    return {
      ...read,
      menu: {
        ...read.menu,
        sections: [
          {
            sectionReference: id(11),
            code: "DIM",
            name: "Dim sum (TEST)",
            nameZh: "点心",
            items: many.map((n) => ({
              placementReference: id(200 + n),
              skuReference: id(n),
              featured: false,
            })),
          },
          ...read.menu.sections,
        ],
      },
      sellables: [
        ...many.map((n) => sellable(n, "Dumpling " + String(n) + " (TEST)", "饺子", "688")),
        ...read.sellables,
      ],
    };
  };
  await routes(page, longMenu);
  await page.route("**/merchant/commerce/availability/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-AVAILABILITY",
        sourceAsOf: at,
        viewer: id(50),
        timeZone: scope.timeZone,
        permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
        items: [...many, 30, 32].map((n) => ({
          skuReference: id(n),
          skuCode: "SKU_" + n,
          productName: "x",
          sizeName: "x",
          status: "Available",
          soldOutUntil: null,
        })),
      },
    }),
  );
  await page.route("**/merchant/commerce/one-store-dishes/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    own = String(body.priceMinor);
    return route.fulfill({
      headers,
      json: {
        status: "Saved",
        productReference: body.productReference,
        choicesWaiting: false,
        price: { brandPriceMinor: "1288", pendingBrandPriceMinor: null, storePriceMinor: own },
        listingNeeded: false,
      },
    });
  });
  const prices = { 1440: "13.10", 1024: "13.20", 390: "13.30" } as const;
  for (const width of [1440, 1024, 390] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/app/commerce/menus");
    await page.getByRole("button", { name: "Edit Dan dan noodles (TEST) 担担面" }).click();
    const editor = page.getByRole("form", { name: "Dan dan noodles (TEST) 担担面" });
    await editor.getByLabel("Price here ($)").fill(prices[width]);
    await editor.getByLabel("Only at this Store — changes now").check();
    await editor.getByRole("button", { name: "Save dish" }).click();
    const row = page.locator(".one-menu__dish").filter({ hasText: "Dan dan noodles (TEST)" });
    const note = row.getByRole("status");
    await expect(note).toHaveText(
      "Dan dan noodles (TEST): guests at this Store pay $" +
        prices[width] +
        " from now. Nothing else changed, so there is nothing to list.",
    );
    await expect(note).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: "test-results/b9-save-note-" + String(width) + ".png" });
  }
  await expectNoInternalText(page);
});

test("@production What goes live names each extra price and the dishes the other Store does not sell yet", async ({
  page,
}) => {
  await routes(page, () =>
    view(false, null, {
      priceDraft: {
        priceBookReference: id(20),
        aggregateVersion: 2,
        startedByViewer: true,
        movedSinceStart: false,
        prices: [{ skuReference: id(30), fromMinor: null, toMinor: "788" }],
      },
      choicePriceChanges: [
        {
          productReference: id(132),
          optionReference: id(90),
          optionName: "Garlic (TEST)",
          fromMinor: "50",
          toMinor: "80",
        },
        {
          productReference: id(132),
          optionReference: id(91),
          optionName: "Egg (TEST)",
          fromMinor: null,
          toMinor: "120",
        },
      ],
      otherStores: {
        storeCount: 1,
        notDecided: [id(30)],
        stores: [{ storeName: "Midtown (TEST)", notDecided: [id(30)] }],
        listingOffers: true,
      },
    }),
  );
  await page.route("**/merchant/commerce/one-store-dishes/command", (route) =>
    route.fulfill({ headers, json: { status: "Listed", menuReference: MENU } }),
  );
  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "List it" }).click();
  const review = page.getByRole("region", { name: "What goes live" });
  await expect(review.getByText("Har gow (TEST): $7.88 (new) (every Store)")).toBeVisible();
  await expect(review.getByRole("heading", { name: "Extra prices" })).toBeVisible();
  await expect(
    review.getByText("Dan dan noodles (TEST), Garlic (TEST): +$0.50 → +$0.80 (every Store)"),
  ).toBeVisible();
  await expect(
    review.getByText("Dan dan noodles (TEST), Egg (TEST): +$1.20 (new) (every Store)"),
  ).toBeVisible();
  await expect(
    review.getByText(
      "New dishes go on sale at the other Stores once listed. A Store that should not sell one hides it there.",
    ),
  ).toBeVisible();
  await expect(review.getByText("Midtown (TEST), 1 dish: Har gow (TEST)")).toBeVisible();
  await noSideScroll(page, "listing-review-extras");
  const axe = await new AxeBuilder({ page }).include(".one-menu").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page);
});

test("@production What goes live names each renamed dish and each dish whose allergens changed (M72)", async ({
  page,
}) => {
  // WP-2423 M72 (v15 2026-11-11 b10): a listing that changes only a name and an allergen read
  // "No price changes." and nothing else. Synthetic, TEST-only data.
  const sesame = id(400);
  const changed = (renames: unknown, allergenChanged: boolean) =>
    view(false, null, {
      allergenRegistry: true,
      allergenChoices: [
        { allergenReference: sesame, code: "SESAME", name: "Sesame seeds", nameZh: "芝麻" },
      ],
      dishRenames: renames,
      sellables: [
        sellable(30, "Har gow (TEST)", "虾饺", "788"),
        {
          ...sellable(32, "Dan dan noodles (TEST)", "担担面", "1288"),
          allergens: {
            source: "StaffDeclared",
            declared: [{ allergenReference: sesame, classification: "CrossContactPossible" }],
            ...(allergenChanged ? { changedByRecipe: true } : {}),
          },
        },
      ],
    });
  let current: unknown = changed(
    [
      {
        skuReference: id(32),
        renamed: [{ locale: "zh-Hans-CA", from: "担担面", to: "四川担担面" }],
      },
    ],
    true,
  );
  await routes(page, () => current);
  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "List it" }).click();
  const shown = page.getByRole("region", { name: "What goes live" });
  await expect(shown.getByText("No price changes.")).toBeVisible();
  await expect(shown.getByRole("heading", { name: "Names and allergens" })).toBeVisible();
  await expect(
    shown.getByText("Dan dan noodles (TEST): Chinese name 担担面 → 四川担担面"),
  ).toBeVisible();
  await expect(
    shown.getByText("Dan dan noodles (TEST): allergens changed · May contain Sesame seeds"),
  ).toBeVisible();
  await noSideScroll(page, "listing-review-names");
  const axe = await new AxeBuilder({ page }).include(".one-menu").analyze();
  expect(axe.violations).toEqual([]);
  // Names could not be compared just now: it says so, never "no changes".
  current = changed(null, false);
  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "List it" }).click();
  const review = page.getByRole("region", { name: "What goes live" });
  await expect(
    review.getByText(
      "Name changes could not be checked just now. The names go live as they are on this page.",
    ),
  ).toBeVisible();
  await expect(review.getByText("No name or allergen changes.")).toHaveCount(0);
  await expectNoInternalText(page);
});

test("@production b12: List it waits while a dish save is on its way and until the menu read after it shows it", async ({
  page,
}) => {
  // v15 b12: List it tapped 42 ms after Save opened What goes live with the menu from before the
  // save. It now waits for the save and the menu read after it. Synthetic, TEST-only data.
  let saved = false;
  let holdReads = false;
  let releaseRead: () => void = () => undefined;
  const current = () =>
    view(false, null, {
      dishRenames: saved
        ? [
            {
              skuReference: id(32),
              renamed: [{ locale: "zh-Hans-CA", from: "担担面", to: "四川担担面" }],
            },
          ]
        : [],
    });
  await routes(page, current);
  await page.route("**/merchant/commerce/menus/query", async (route) => {
    const body = route.request().postDataJSON() as { menuReference: string | null };
    if (body.menuReference === null || !holdReads) return route.fallback();
    await new Promise<void>((resolve) => (releaseRead = resolve));
    return route.fulfill({ headers, json: current() });
  });
  let releaseSave: () => void = () => undefined;
  await page.route("**/merchant/commerce/one-store-dishes/command", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await new Promise<void>((resolve) => (releaseSave = resolve));
    saved = true;
    return route.fulfill({
      headers,
      json: {
        status: "Saved",
        productReference: body.productReference,
        choicesWaiting: false,
        price: { brandPriceMinor: "1288", pendingBrandPriceMinor: null, storePriceMinor: null },
        listingNeeded: true,
      },
    });
  });
  await page.goto("/app/commerce/menus");
  const listIt = page.getByRole("button", { name: "List it", exact: true });
  await expect(listIt).toBeEnabled();
  await page.getByRole("button", { name: "Edit Dan dan noodles (TEST) 担担面" }).click();
  const editor = page.getByRole("form", { name: "Dan dan noodles (TEST) 担担面" });
  await editor.getByLabel("Chinese name").fill("四川担担面");
  holdReads = true;
  await editor.getByRole("button", { name: "Save dish" }).click();
  await expect(page.getByText("Saving… List it once the menu shows what you saved.")).toBeVisible();
  await expect(listIt).toBeDisabled();
  await noSideScroll(page, "b12-list-waits-saving");
  releaseSave();
  await expect(
    page.getByText("Reading the menu again to show what you saved. List it once it shows."),
  ).toBeVisible();
  await expect(listIt).toBeDisabled();
  await expect(page.getByRole("region", { name: "What goes live" })).toHaveCount(0);
  holdReads = false;
  releaseRead();
  await expect(listIt).toBeEnabled();
  await expect(page.getByText("List it once", { exact: false })).toHaveCount(0);
  await listIt.click();
  const review = page.getByRole("region", { name: "What goes live" });
  await expect(
    review.getByText("Dan dan noodles (TEST): Chinese name 担担面 → 四川担担面"),
  ).toBeVisible();
  await noSideScroll(page, "b12-list-waits-review");
  const axe = await new AxeBuilder({ page }).include(".one-menu").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page);
});
