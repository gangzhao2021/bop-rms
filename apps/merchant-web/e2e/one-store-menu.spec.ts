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
    // As on v15 (2026-10-28 finding a): the release names the menu's current version, which is
    // not the draft version id the builder shows; the server's listing step decides.
    latestRelease:
      released === null
        ? null
        : { releaseReference: id(7), sequence: 1, menuVersionReference: released, createdAt: at },
    listingStep: released === null ? "Submit" : "Listed",
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
      released = id(8);
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
  // "List it" lists the open price book, waiting choice prices and the menu together.
  await page.route("**/merchant/commerce/one-store-dishes/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    menuCommands.push({ ...body, action: body.action === "ListAll" ? "List" : body.action });
    if (refuseListing)
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "NotSingleStore", part: "Menu" },
      });
    released = id(8);
    return route.fulfill({ headers, json: { status: "Listed", menuReference: MENU } });
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
  // Still listed after a reload: no "List it", no "saved changes not listed".
  await page.reload();
  await expect(page.locator(".one-menu__dish").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "List it" })).toHaveCount(0);
  await expect(
    page.getByText("There are saved changes not listed yet.", { exact: false }),
  ).toHaveCount(0);
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

test("@production one dish edited on the one-page menu: names, price, choices, allergens; new dish and section; List it", async ({
  page,
}) => {
  // The menu has not been listed yet (state left by the test before is reset).
  released = null;
  refuseListing = false;
  await session(page);
  const peanut = id(60),
    sesame = id(61),
    wheat = id(62),
    spice = id(70),
    mild = id(71),
    hot = id(72),
    tax = id(75);
  const declared = new Map<string, { allergenReference: string; classification: string }[]>([
    [id(30), [{ allergenReference: wheat, classification: "Contains" }]],
  ]);
  const pending = new Map<string, string>();
  let keepsStock = false;
  const order = [
    [30, 31],
    [32, 33],
  ];
  let extraSections: { code: string; name: string; nameZh: string }[] = [];
  const dishCommands: Record<string, unknown>[] = [];
  const menuCommands: Record<string, unknown>[] = [];
  const view = () => {
    const base = builder(3, order);
    return {
      ...base,
      menu: {
        ...base.menu,
        sections: [
          ...base.menu.sections,
          ...extraSections.map((x, n) => ({
            sectionReference: id(12 + n),
            code: x.code,
            name: x.name,
            nameZh: x.nameZh,
            items: [],
          })),
        ],
      },
      allergenRegistry: true,
      allergenChoices: [
        { allergenReference: peanut, name: "Peanuts", nameZh: "花生" },
        { allergenReference: sesame, name: "Sesame", nameZh: "芝麻" },
        { allergenReference: wheat, name: "Wheat", nameZh: "小麦" },
      ],
      keepsStock,
      sellables: base.sellables.map((s) => ({
        ...s,
        productReference: id(Number.parseInt(s.skuReference.slice(-12), 16) + 100),
        pendingPriceMinor: pending.get(s.skuReference) ?? null,
        allergens:
          s.skuReference === id(33)
            ? { source: "Recipe", declared: [] }
            : declared.has(s.skuReference)
              ? { source: "StaffDeclared", declared: declared.get(s.skuReference) }
              : { source: "None", declared: [] },
      })),
    };
  };
  await page.route("**/merchant/commerce/menus/query", (route) => {
    const body = route.request().postDataJSON() as { menuReference: string | null };
    if (body.menuReference !== null) return route.fulfill({ headers, json: view() });
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-MENU-LIST",
        sourceAsOf: at,
        viewer: id(50),
        permissions: view().permissions,
        menus: [
          {
            menuReference: MENU,
            internalCode: "MAIN",
            aggregateVersion: 3,
            currentVersionReference: id(2),
            localizedNames: { "en-CA": "TEST menu" },
            placements: 4,
            publication: null,
            latestRelease: null,
          },
        ],
      },
    });
  });
  await page.route("**/merchant/commerce/menus/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    menuCommands.push(body);
    const sections = body.sections as { code: string; name: string; nameZh: string }[];
    extraSections = sections.filter((x) => !["DIM", "NOODLE"].includes(x.code));
    return route.fulfill({ headers, json: { ok: true } });
  });
  const groups = [
    {
      optionSetReference: spice,
      name: "Spice level",
      archived: false,
      displayStyle: "SingleChoice",
      minimum: 1,
      maximum: 1,
      perOptionMaximum: 1,
      options: [
        { optionReference: mild, name: "Mild", offered: true },
        { optionReference: hot, name: "Hot", offered: true },
      ],
    },
  ];
  const taxClasses = [
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
  ];
  await page.route("**/merchant/commerce/products/query", (route) => {
    const body = route.request().postDataJSON() as { productReference: string | null };
    const base = {
      sourceAsOf: at,
      locale: "en-CA",
      permissions: {},
      productTypes: [],
      sellingUnits: [],
      taxClasses,
      optionSetChoices: groups,
    };
    if (body.productReference === null)
      return route.fulfill({
        headers,
        json: { screenId: "CAT-PRODUCT-LIST", ...base, products: [] },
      });
    const sku = Number.parseInt(body.productReference.slice(-12), 16) - 100;
    const row = view().sellables.find((x) => x.skuReference === id(sku));
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-PRODUCT-DETAIL",
        ...base,
        product: {
          productReference: body.productReference,
          name: row?.productName,
          nameZh: row?.productNameZh,
          taxClassificationReference: tax,
          sizes: [
            { skuReference: id(sku), skuCode: "SKU_" + sku, name: row?.productName, nameZh: "" },
          ],
          optionSets: [],
          presentation: { description: "Steamed (TEST)", descriptionZh: "", photo: null },
        },
      },
    });
  });
  await page.route("**/merchant/commerce/option-prices/query", (route) =>
    route.fulfill({ headers, json: { screenId: "PRICE-OPTION-LIST", products: [] } }),
  );
  // A simple choice group made from the dish editor (saved directly, as the choice groups page).
  const groupCommands: Record<string, unknown>[] = [];
  await page.route("**/merchant/commerce/option-sets/command", (route) => {
    const body = route.request().postDataJSON() as {
      name: string;
      options: { name: string }[];
    } & Record<string, unknown>;
    groupCommands.push(body);
    const optionSetReference = id(80 + groupCommands.length);
    groups.push({
      optionSetReference,
      name: body.name,
      archived: false,
      displayStyle: "SingleChoice",
      minimum: 0,
      maximum: 1,
      perOptionMaximum: 1,
      options: body.options.map((o, n) => ({
        optionReference: id(90 + n),
        name: o.name,
        offered: true,
      })),
    });
    return route.fulfill({
      headers,
      json: { status: "Applied", optionSet: { optionSetReference } },
    });
  });
  await page.route("**/merchant/commerce/one-store-dishes/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    dishCommands.push(body);
    if (body.action === "SaveDish" && body.productReference !== null) {
      const sku = id(Number.parseInt(String(body.productReference).slice(-12), 16) - 100);
      pending.set(sku, String(body.priceMinor));
      if (body.allergens !== null)
        declared.set(
          sku,
          body.allergens as { allergenReference: string; classification: string }[],
        );
    }
    return route.fulfill({
      headers,
      json: { status: body.action === "ListAll" ? "Listed" : "Saved" },
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
        items: [30, 31, 32, 33].map((n) => ({
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

  await page.goto("/app/commerce/menus");
  const row = (name: string) => page.locator(".one-menu__dish").filter({ hasText: name });
  await expect(row("Har gow")).toContainText("Contains Wheat");
  await expect(row("Siu mai")).toContainText("Allergens not declared");
  await expect(row("Beef chow fun")).toContainText("Allergens from its recipe");
  await page
    .getByRole("group", { name: "Show only" })
    .getByRole("button", { name: "Allergens not declared" })
    .click();
  await expect(page.locator(".one-menu__dish .one-menu__name")).toHaveText([
    "Siu mai (TEST)",
    "Dan dan noodles (TEST)",
  ]);
  await page
    .getByRole("group", { name: "Show only" })
    .getByRole("button", { name: "Allergens not declared" })
    .click();

  // Siu mai: Chinese description, a new price, the spice group (hot +0.50) and its allergens.
  await page.getByRole("button", { name: "Edit Siu mai (TEST) 烧卖" }).click();
  const editor = page.getByRole("form", { name: "Siu mai (TEST) 烧卖" });
  await expect(editor.getByLabel("English name")).toHaveValue("Siu mai (TEST)");
  await expect(editor.getByLabel("English description")).toHaveValue("Steamed (TEST)");
  await editor.getByLabel("Chinese description").fill("蒸（测试）");
  await editor.getByLabel("Price ($)").fill("7.50");
  await editor.getByRole("checkbox", { name: "Spice level" }).check();
  await editor.getByLabel("Extra ($) for Hot").fill("0.50");
  await expect(editor.getByText("Allergens declared by staff")).toBeVisible();
  await editor.getByRole("radiogroup", { name: "Peanuts 花生" }).getByLabel("Contains").check();
  await editor.getByRole("radiogroup", { name: "Sesame 芝麻" }).getByLabel("May contain").check();
  await expect(
    editor.getByRole("checkbox", { name: "I checked every allergen of this dish." }),
  ).toBeChecked();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/dish-editor-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page }).include(".one-menu").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page);
  await editor.getByRole("button", { name: "Save dish" }).click();
  await expect(
    page.getByText("Siu mai (TEST) saved. Guests see it when the menu is listed."),
  ).toBeVisible();
  await expect(row("Siu mai")).toContainText("→ $7.50 when listed");
  await expect(row("Siu mai")).toContainText("Contains Peanuts · May contain Sesame");
  expect(dishCommands[0]).toMatchObject({
    action: "SaveDish",
    menuReference: MENU,
    productReference: id(131),
    sectionCode: "DIM",
    name: "Siu mai (TEST)",
    nameZh: "烧卖",
    description: "Steamed (TEST)",
    descriptionZh: "蒸（测试）",
    taxClassificationReference: tax,
    priceMinor: "750",
    choiceGroups: [
      {
        optionSetReference: spice,
        options: [
          { optionReference: mild, amountMinor: "0" },
          { optionReference: hot, amountMinor: "50" },
        ],
      },
    ],
    allergens: [
      { allergenReference: peanut, classification: "Contains" },
      { allergenReference: sesame, classification: "CrossContactPossible" },
    ],
  });

  // A dish with a real recipe takes its allergens from it; nothing is declared over it.
  await page.getByRole("button", { name: "Edit Beef chow fun (TEST) 干炒牛河" }).click();
  await expect(
    page.getByText("This dish has a recipe, so its allergens come from the recipe's ingredients."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // A new section, then a new dish in it.
  await page.getByRole("button", { name: "New section" }).click();
  const sectionForm = page.getByRole("form", { name: "New section" });
  await sectionForm.getByLabel("English name").fill("Soups (TEST)");
  await sectionForm.getByLabel("Chinese name").fill("汤");
  await sectionForm.getByRole("button", { name: "Add section" }).click();
  await expect(page.getByText("Section added.", { exact: false })).toBeVisible();
  expect(menuCommands.at(-1)).toMatchObject({
    action: "SaveDraft",
    sections: [
      { code: "DIM" },
      { code: "NOODLE" },
      { sectionReference: null, code: "SOUPS-TEST", name: "Soups (TEST)", nameZh: "汤", items: [] },
    ],
  });
  await page.getByRole("button", { name: "New dish" }).click();
  const fresh = page.getByRole("form", { name: "New dish" });
  await fresh.getByLabel("English name").fill("Hot and sour soup (TEST)");
  await fresh.getByLabel("Chinese name").fill("酸辣汤");
  await fresh.getByLabel("Price ($)").fill("6.50");
  await fresh.getByLabel("Section").selectOption("SOUPS-TEST");
  await fresh.getByRole("radiogroup", { name: "Wheat 小麦" }).getByLabel("Contains").check();
  await fresh.getByRole("button", { name: "Save dish" }).click();
  await expect(page.getByText("Hot and sour soup (TEST) saved.", { exact: false })).toBeVisible();
  expect(dishCommands.at(-1)).toMatchObject({
    action: "SaveDish",
    productReference: null,
    sectionCode: "SOUPS-TEST",
    name: "Hot and sour soup (TEST)",
    nameZh: "酸辣汤",
    priceMinor: "650",
    choiceGroups: [],
    allergens: [{ allergenReference: wheat, classification: "Contains" }],
  });

  // List it: the price book, choice prices and menu together.
  await page.getByRole("button", { name: "List it" }).click();
  await expect(page.getByText("Listed. Guests see the menu as it is now.")).toBeVisible();
  expect(dishCommands.at(-1)).toMatchObject({ action: "ListAll", menuReference: MENU });

  // 加饭 made from the editor: at most one, optional; it is chosen for the dish at once.
  await page.getByRole("button", { name: "Edit Dan dan noodles (TEST)" }).click();
  const noodles = page.getByRole("form", { name: "Dan dan noodles (TEST)" });
  await noodles.getByRole("button", { name: "New choice group" }).click();
  const made = noodles.getByRole("group", { name: "New choice group" });
  await made.getByLabel("Group name (English)").fill("Add rice (TEST)");
  await made.getByLabel("Group name (Chinese)").fill("加饭");
  await made.getByLabel("Required; the first choice is the default").uncheck();
  await made.getByLabel("Choice 1 (English)").fill("Steamed rice");
  await made.getByLabel("Choice 1 (Chinese)").fill("加一碗白饭");
  await made.getByLabel("Choice 2 (English)").fill("Egg fried rice");
  await made.getByLabel("Choice 2 (Chinese)").fill("加一份蛋炒饭");
  await made.getByRole("button", { name: "Make the group" }).click();
  await expect(noodles.getByRole("checkbox", { name: "Add rice (TEST)" })).toBeChecked();
  await noodles.getByLabel("Extra ($) for Steamed rice").fill("2.50");
  expect(groupCommands[0]).toMatchObject({
    action: "Create",
    name: "Add rice (TEST)",
    nameZh: "加饭",
    kind: "One",
    minimum: 0,
    maximum: 1,
    options: [
      { name: "Steamed rice", nameZh: "加一碗白饭", defaultChoice: false },
      { name: "Egg fried rice", nameZh: "加一份蛋炒饭", defaultChoice: false },
    ],
  });
  const axeGroups = await new AxeBuilder({ page }).include(".one-menu").analyze();
  expect(axeGroups.violations).toEqual([]);
  await noodles.getByRole("button", { name: "Close" }).last().click();

  // Once the store keeps stock, staff are asked to replace declared allergens with a recipe.
  keepsStock = true;
  await page.reload();
  await page.getByRole("button", { name: "Edit Har gow (TEST) 虾饺" }).click();
  await expect(
    page.getByText("This store keeps stock and recipes. Replace these declared allergens", {
      exact: false,
    }),
  ).toBeVisible();
});

test("@production a dish with sizes is one row: its sizes inside, hidden together, sold out per size", async ({
  page,
}) => {
  released = null;
  refuseListing = false;
  await session(page);
  const status = new Map<string, string>();
  const stockCommands: Record<string, unknown>[] = [];
  const menuCommands: Record<string, unknown>[] = [];
  let order = [[40, 41, 30, 42], [32]];
  const latte = (n: number, size: string, price: string) => ({
    ...sellable(n, "Latte (TEST)", "拿铁", price),
    sizeName: size,
    productReference: id(70),
  });
  const view = () => {
    const base = builder(3, order);
    return {
      ...base,
      sellables: [
        { ...sellable(30, "Har gow (TEST)", "虾饺", "788"), productReference: id(71) },
        { ...sellable(32, "Dan dan noodles (TEST)", "担担面", "1288"), productReference: id(72) },
        latte(40, "Small", "450"),
        latte(41, "Regular", "495"),
        latte(42, "Large", "550"),
      ],
    };
  };
  await page.route("**/merchant/commerce/menus/query", (route) => {
    const body = route.request().postDataJSON() as { menuReference: string | null };
    if (body.menuReference !== null) return route.fulfill({ headers, json: view() });
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-MENU-LIST",
        sourceAsOf: at,
        viewer: id(50),
        permissions: view().permissions,
        menus: [
          {
            menuReference: MENU,
            internalCode: "MAIN",
            aggregateVersion: 3,
            currentVersionReference: id(2),
            localizedNames: { "en-CA": "TEST menu" },
            placements: 5,
            publication: null,
            latestRelease: null,
          },
        ],
      },
    });
  });
  await page.route("**/merchant/commerce/menus/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    menuCommands.push(body);
    const sections = body.sections as { items: { skuReference: string }[] }[] | undefined;
    if (sections)
      order = sections.map((section) =>
        section.items.map((item) => Number.parseInt(item.skuReference.slice(-12), 16)),
      );
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
        items: [30, 32, 40, 41, 42].map((n) => ({
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
    status.set(
      String(body.skuReference),
      body.action === "SoldOut"
        ? "SoldOut"
        : body.action === "StopOffering"
          ? "NotOffered"
          : "Available",
    );
    return route.fulfill({ headers, json: { ok: true } });
  });

  await page.goto("/app/commerce/menus");
  const dishes = page.locator(".one-menu__dish .one-menu__name");
  // Latte once, with its three sizes and prices inside; the other dishes as before.
  await expect(dishes).toHaveText(["Latte (TEST)", "Har gow (TEST)", "Dan dan noodles (TEST)"]);
  const latteRow = page.locator(".one-menu__dish").filter({ hasText: "Latte" });
  await expect(
    latteRow.getByRole("list", { name: "Sizes of Latte (TEST)" }).getByRole("listitem"),
  ).toHaveText([/Small\s*\$4\.50/u, /Regular\s*\$4\.95/u, /Large\s*\$5\.50/u]);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/dish-sizes-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page }).include(".one-menu").analyze();
  expect(axe.violations).toEqual([]);

  // Sold out per size, inside the row.
  await latteRow.getByRole("button", { name: "Sold out today: Latte (TEST) — Large" }).click();
  await expect(latteRow.getByRole("listitem").filter({ hasText: "Large" })).toContainText(
    "Sold out today",
  );
  expect(stockCommands.at(-1)).toMatchObject({ action: "SoldOut", skuReference: id(42) });
  // Hide acts on the whole dish: every size.
  await latteRow.getByRole("button", { name: "Hide" }).click();
  await expect(latteRow.getByRole("button", { name: "Show to guests" })).toBeVisible();
  expect(stockCommands.slice(-3).map((c) => [c.action, c.skuReference])).toEqual([
    ["StopOffering", id(40)],
    ["StopOffering", id(41)],
    ["StopOffering", id(42)],
  ]);

  // Moving the dish moves its sizes together; the draft keeps them in their order.
  await page.getByRole("button", { name: "Move Latte (TEST) down" }).click();
  await expect(dishes).toHaveText(["Har gow (TEST)", "Latte (TEST)", "Dan dan noodles (TEST)"]);
  await page.getByRole("button", { name: "Save order" }).click();
  await expect(page.getByText("New order saved.", { exact: false })).toBeVisible();
  expect(menuCommands.at(-1)).toMatchObject({
    action: "SaveDraft",
    sections: [
      {
        code: "DIM",
        items: [
          { skuReference: id(30) },
          { skuReference: id(40) },
          { skuReference: id(41) },
          { skuReference: id(42) },
        ],
      },
      { code: "NOODLE", items: [{ skuReference: id(32) }] },
    ],
  });
});

test("@production a listing in progress shows as such, also after a reload, until it is live", async ({
  page,
}) => {
  released = null;
  refuseListing = false;
  let underway = false;
  await session(page);
  await page.route("**/merchant/commerce/menus/query", (route) => {
    const body = route.request().postDataJSON() as { menuReference: string | null };
    const view = {
      ...builder(3, [
        [30, 31],
        [32, 33],
      ]),
      ...(underway && released === null ? { listingStep: "Approve" } : {}),
    };
    if (body.menuReference !== null) return route.fulfill({ headers, json: view });
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-MENU-LIST",
        sourceAsOf: at,
        viewer: id(50),
        permissions: view.permissions,
        menus: [
          {
            menuReference: MENU,
            internalCode: "MAIN",
            aggregateVersion: 3,
            currentVersionReference: id(2),
            localizedNames: { "en-CA": "TEST menu" },
            placements: 4,
            publication: null,
            latestRelease: null,
          },
        ],
      },
    });
  });
  const listings: Record<string, unknown>[] = [];
  // The listing takes 5 s on the server; it finishes even if the page that asked is reloaded.
  await page.route("**/merchant/commerce/one-store-dishes/command", async (route) => {
    listings.push(route.request().postDataJSON() as Record<string, unknown>);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    released = id(8);
    await route
      .fulfill({ headers, json: { status: "Listed", menuReference: MENU } })
      .catch(() => undefined);
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
          status: "Available",
          soldOutUntil: null,
        })),
      },
    }),
  );

  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "List it" }).click();
  await expect(
    page.getByText("Listing… Prices, choices and the menu go live together", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "List it" })).toHaveCount(0);
  // A reload during the listing still shows it in progress, with no second "List it".
  await page.reload();
  await expect(
    page.getByText("Listing… Prices, choices and the menu go live together", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "List it" })).toHaveCount(0);
  await expect(
    page.getByText("There are saved changes not listed yet.", { exact: false }),
  ).toHaveCount(0);
  // When the server has it live, the page says nothing is waiting.
  await expect(page.getByText("Listing…", { exact: false })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "List it" })).toHaveCount(0);
  expect(listings).toHaveLength(1);

  // The server shows a listing part-way (in review), started elsewhere or stopped: the page
  // says so and offers to continue it, never a fresh "List it".
  released = null;
  underway = true;
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(
    page.getByText("A listing is under way or stopped part-way.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue listing" })).toBeVisible();
});
