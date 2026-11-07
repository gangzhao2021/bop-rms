import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 3: an owner sets up a run of drinks on the one-page menu. After the first drink, each
 * next one is its names, its price and one allergen tick; a choice's usual extra is offered; a new
 * topping reaches other dishes with its money and allergens asked. Synthetic, TEST-only data.
 */
const id = (n: number) => "0190996c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const at = "2026-11-05T19:00:00.000Z";
const MENU = id(1);
const tax = id(75);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const milk = id(60),
  soy = id(61),
  wheat = id(62);
const toppings = id(70),
  pearls = id(71),
  pudding = id(72),
  foam = id(73);
const size = id(80),
  medium = id(81),
  large = id(82);
const oldGroup = id(85),
  comboSlot = id(86);
const stirFry = id(140);

interface Dish {
  sku: string;
  product: string;
  section: string;
  name: string;
  nameZh: string;
  description: string;
  price: string | null;
  allergens: { source: string; declared: unknown[]; noIngredients?: boolean };
  /** option set to option to extra in cents */
  chosen: Map<string, Map<string, string>>;
}
interface Fixture {
  dishes: Dish[];
  usual: Record<string, string>;
  dishCommands: Record<string, unknown>[];
  markCommands: Record<string, unknown>[];
  sectionCommands: Record<string, unknown>[];
  alcoholCommands: Record<string, unknown>[];
  groupCommands: Record<string, unknown>[];
  /** The next saves: an error body with its status, or null for one that goes through. */
  failSaves: ({ status: number; json: Record<string, unknown> } | null)[];
  failMenuReads: number;
  keepsStock: boolean;
  allergenList: boolean;
  optionPriceQueries: unknown[];
  explicitMarks: Map<string, boolean>;
  alcohol: Set<string>;
  kitchenSection: Map<string, string>;
  /** A Brand with a second menu (lunch and dinner): the plain menu list shows. */
  secondMenu?: boolean;
}

let nextDish = 500;
const dish = (
  name: string,
  nameZh: string,
  section: string,
  price: string | null,
  allergens: Dish["allergens"],
  chosen: [string, [string, string][]][] = [],
): Dish => {
  const n = nextDish++;
  return {
    sku: id(n),
    product: id(n + 1000),
    section,
    name,
    nameZh,
    description: "",
    price,
    allergens,
    chosen: new Map(chosen.map(([set, options]) => [set, new Map(options)])),
  };
};

async function setUp(page: Page, overrides: Partial<Fixture> = {}): Promise<Fixture> {
  const f: Fixture = {
    dishes: [
      dish(
        "Milk tea (TEST)",
        "奶茶",
        "DRINKS",
        "550",
        {
          source: "StaffDeclared",
          declared: [{ allergenReference: milk, classification: "Contains" }],
        },
        [
          [
            toppings,
            [
              [pearls, "80"],
              [pudding, "120"],
            ],
          ],
          [
            size,
            [
              [medium, "0"],
              [large, "100"],
            ],
          ],
          [oldGroup, [[id(87), "50"]]],
        ],
      ),
      dish("Corkage (TEST)", "开瓶费", "DRINKS", "500", {
        source: "StaffDeclared",
        declared: [],
        noIngredients: true,
      }),
      dish(
        "Fruit tea (TEST)",
        "果茶",
        "DRINKS",
        "600",
        {
          source: "StaffDeclared",
          declared: [{ allergenReference: soy, classification: "CrossContactPossible" }],
        },
        [
          [toppings, [[pearls, "90"]]],
          [size, [[large, "150"]]],
        ],
      ),
      dish("Coffee (TEST)", "咖啡", "DRINKS", "450", { source: "None", declared: [] }),
      dish("Fried rice (TEST)", "炒饭", "FOOD", "1200", { source: "Recipe", declared: [] }),
    ],
    usual: { [pearls]: "80", [pudding]: "120", [medium]: "0", [large]: "100" },
    dishCommands: [],
    markCommands: [],
    sectionCommands: [],
    alcoholCommands: [],
    groupCommands: [],
    failSaves: [],
    failMenuReads: 0,
    keepsStock: false,
    allergenList: true,
    optionPriceQueries: [],
    explicitMarks: new Map(),
    alcohol: new Set(),
    kitchenSection: new Map(),
    ...overrides,
  };
  const groups = [
    {
      optionSetReference: toppings,
      name: "Toppings",
      archived: false,
      comboPart: false,
      displayStyle: "MultiSelect",
      minimum: 0,
      maximum: null,
      perOptionMaximum: 1,
      options: [
        { optionReference: pearls, name: "Pearls", offered: true },
        { optionReference: pudding, name: "Pudding", offered: true },
        { optionReference: foam, name: "Cheese foam", offered: true },
      ],
    },
    {
      optionSetReference: size,
      name: "Size",
      archived: false,
      comboPart: false,
      displayStyle: "SingleChoice",
      minimum: 1,
      maximum: 1,
      perOptionMaximum: 1,
      options: [
        { optionReference: medium, name: "Medium", offered: true },
        { optionReference: large, name: "Large", offered: true },
      ],
    },
    {
      optionSetReference: oldGroup,
      name: "Old promotion",
      archived: true,
      comboPart: false,
      displayStyle: "SingleChoice",
      minimum: 0,
      maximum: 1,
      perOptionMaximum: 1,
      options: [{ optionReference: id(87), name: "Old", offered: true }],
    },
    {
      optionSetReference: comboSlot,
      name: "Combo drink part",
      archived: false,
      comboPart: true,
      displayStyle: "SingleChoice",
      minimum: 1,
      maximum: 1,
      perOptionMaximum: 1,
      options: [{ optionReference: id(88), name: "Tea", offered: true }],
    },
  ] as {
    optionSetReference: string;
    name: string;
    archived: boolean;
    comboPart: boolean;
    displayStyle: string;
    minimum: number;
    maximum: number | null;
    perOptionMaximum: number;
    options: { optionReference: string; name: string; offered: boolean }[];
  }[];
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
          businessDate: "2026-11-05",
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
            {
              screenId: "CAT-OPTIONSET-LIST",
              label: "Option sets",
              href: "/app/commerce/option-sets",
              permission: "catalog.option_set.read",
            },
          ],
        },
      },
    }),
  );
  const permissions = {
    mayRead: true,
    mayEdit: true,
    maySubmit: true,
    mayApprove: true,
    mayPublish: true,
  };
  const view = () => ({
    screenId: "CAT-MENU-BUILDER",
    sourceAsOf: at,
    viewer: id(50),
    permissions,
    menus: [],
    menu: {
      menuReference: MENU,
      internalCode: "MAIN",
      aggregateVersion: 3,
      versionReference: id(2),
      name: "TEST menu",
      storeReferences: [scope.storeReference],
      channelCodes: ["CUSTOMER_PWA"],
      orderTypeCodes: ["DINE_IN"],
      sections: [
        { sectionReference: id(10), code: "DRINKS", name: "Drinks (TEST)", nameZh: "饮品" },
        { sectionReference: id(11), code: "FOOD", name: "Food (TEST)", nameZh: "主食" },
      ].map((section) => ({
        ...section,
        items: f.dishes
          .filter((d) => d.section === section.code)
          .map((d, index) => ({
            placementReference: id(2000 + index + (section.code === "FOOD" ? 500 : 0)),
            skuReference: d.sku,
            featured: false,
          })),
      })),
    },
    publication: null,
    latestRelease: null,
    listingStep: "Submit",
    submittedBy: null,
    soleOperator: null,
    allergenRegistry: f.allergenList,
    allergenChoices: f.allergenList
      ? [
          { allergenReference: milk, name: "Milk", nameZh: "牛奶" },
          { allergenReference: soy, name: "Soy", nameZh: "大豆" },
          { allergenReference: wheat, name: "Wheat", nameZh: "小麦" },
        ]
      : [],
    keepsStock: f.keepsStock,
    sellables: f.dishes.map((d) => ({
      skuReference: d.sku,
      skuCode: "SKU_TEST",
      productName: d.name,
      productNameZh: d.nameZh,
      sizeName: d.name,
      active: true,
      priceMinor: d.price,
      offeredHere: true,
      productReference: d.product,
      pendingPriceMinor: null,
      allergens: d.allergens,
    })),
    mayOfferHere: true,
    customerView: null,
  });
  await page.route("**/merchant/commerce/menus/query", (route) => {
    const body = route.request().postDataJSON() as { menuReference: string | null };
    if (body.menuReference !== null) {
      if (f.failMenuReads > 0) {
        f.failMenuReads -= 1;
        return route.fulfill({ status: 503, headers, json: { error: "Unavailable" } });
      }
      return route.fulfill({ headers, json: view() });
    }
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-MENU-LIST",
        sourceAsOf: at,
        viewer: id(50),
        permissions,
        menus: [
          {
            menuReference: MENU,
            internalCode: "MAIN",
            aggregateVersion: 3,
            currentVersionReference: id(2),
            localizedNames: { "en-CA": "TEST menu" },
            placements: f.dishes.length,
            publication: null,
            latestRelease: null,
          },
          ...(f.secondMenu === true
            ? [
                {
                  menuReference: id(3),
                  internalCode: "DINNER",
                  aggregateVersion: 1,
                  currentVersionReference: id(4),
                  localizedNames: { "en-CA": "TEST dinner" },
                  placements: 1,
                  publication: null,
                  latestRelease: null,
                },
              ]
            : []),
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
        items: f.dishes.map((d) => ({
          skuReference: d.sku,
          skuCode: "SKU_TEST",
          productName: d.name,
          sizeName: d.name,
          status: "Available",
          soldOutUntil: null,
        })),
      },
    }),
  );
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
    const found = f.dishes.find((d) => d.product === body.productReference);
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-PRODUCT-DETAIL",
        ...base,
        product: {
          productReference: body.productReference,
          name: found?.name,
          nameZh: found?.nameZh,
          taxClassificationReference: tax,
          sizes: [{ skuReference: found?.sku, skuCode: "SKU_TEST", name: found?.name, nameZh: "" }],
          optionSets: [...(found?.chosen ?? [])].map(([optionSetReference, options]) => ({
            optionSetReference,
            enabledOptionReferences: [...options.keys()],
          })),
          presentation: { description: found?.description ?? "", descriptionZh: "", photo: null },
        },
      },
    });
  });
  await page.route("**/merchant/commerce/option-prices/query", (route) => {
    const body = route.request().postDataJSON() as { productReference?: string | null };
    f.optionPriceQueries.push(body);
    const listed = (d: Dish) => ({
      productReference: d.product,
      name: d.name,
      optionSets: [...d.chosen].map(([optionSetReference, options]) => ({
        bindingReference: id(3000),
        optionSetReference,
        name: "x",
        options: [...options].map(([optionReference, priceMinor]) => ({
          optionReference,
          name: "x",
          offered: true,
          priceMinor,
          pending: null,
        })),
      })),
    });
    return route.fulfill({
      headers,
      json:
        "productReference" in body
          ? {
              screenId: "PRICE-OPTION-LIST",
              products: f.dishes.filter((d) => d.product === body.productReference).map(listed),
              usual: f.usual,
            }
          : { screenId: "PRICE-OPTION-LIST", products: f.dishes.map(listed) },
    });
  });
  await page.route("**/merchant/commerce/one-store-dishes/command", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown> & {
      productReference: string | null;
      choiceGroups: {
        optionSetReference: string;
        options: { optionReference: string; amountMinor: string }[];
      }[];
    };
    f.dishCommands.push(body);
    const failure = f.failSaves.shift();
    if (failure !== undefined && failure !== null)
      return route.fulfill({ status: failure.status, headers, json: failure.json });
    if (body.action !== "SaveDish") return route.fulfill({ headers, json: { status: "Listed" } });
    let target = f.dishes.find((d) => d.product === body.productReference);
    if (target === undefined) {
      target = dish(String(body.name), String(body.nameZh), String(body.sectionCode), "0", {
        source: "None",
        declared: [],
      });
      f.dishes.push(target);
    }
    target.name = String(body.name);
    target.nameZh = String(body.nameZh);
    if (body.priceMinor !== null) target.price = String(body.priceMinor);
    target.chosen = new Map(
      body.choiceGroups.map((group) => [
        group.optionSetReference,
        new Map(group.options.map((option) => [option.optionReference, option.amountMinor])),
      ]),
    );
    for (const group of body.choiceGroups)
      for (const option of group.options) f.usual[option.optionReference] ??= option.amountMinor;
    if (body.allergens === "NoIngredients")
      target.allergens = { source: "StaffDeclared", declared: [], noIngredients: true };
    else if (Array.isArray(body.allergens))
      // As the server records it: the No answers prove each row was answered, never stored.
      target.allergens = {
        source: "StaffDeclared",
        declared: (body.allergens as { classification: string }[]).filter(
          (a) => a.classification !== "None",
        ),
      };
    const waiting = target.allergens.source === "None" && body.choiceGroups.length > 0;
    return route.fulfill({
      headers,
      json: {
        status: "Saved",
        productReference: target.product,
        skuReference: target.sku,
        choicesWaiting: waiting,
      },
    });
  });
  await page.route("**/merchant/commerce/kitchen-not-prepared/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "Change") {
      f.markCommands.push(body);
      f.explicitMarks.set(String(body.productReference), body.notPrepared === true);
    }
    const products =
      body.action === "Read"
        ? (body.productReferences as string[])
        : [String(body.productReference)];
    return route.fulfill({
      headers,
      json: {
        products: products.map((productReference) => {
          const own = f.explicitMarks.get(productReference);
          const fee =
            f.dishes.find((d) => d.product === productReference)?.allergens.noIngredients === true;
          return {
            productReference,
            notPrepared: own ?? fee,
            version: own === undefined ? 0 : 1,
            decided: own !== undefined,
            notPreparedByDefault: fee,
          };
        }),
      },
    });
  });
  await page.route("**/merchant/commerce/kitchen-sections/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "ChangeDish") {
      f.sectionCommands.push(body);
      f.kitchenSection.set(String(body.productReference), String(body.sectionReference));
    }
    const products =
      body.action === "Read"
        ? (body.productReferences as string[])
        : [String(body.productReference)];
    return route.fulfill({
      headers,
      json: {
        version: 1,
        sections: [{ sectionReference: stirFry, name: "Bar (TEST)" }],
        products: products.map((productReference) => ({
          productReference,
          sectionReference: f.kitchenSection.get(productReference) ?? null,
          version: f.kitchenSection.has(productReference) ? 1 : 0,
        })),
      },
    });
  });
  await page.route("**/merchant/commerce/product-alcohol/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "Change") {
      f.alcoholCommands.push(body);
      if (body.containsAlcohol === true) f.alcohol.add(String(body.productReference));
    }
    const products =
      body.action === "Read"
        ? (body.productReferences as string[])
        : [String(body.productReference)];
    return route.fulfill({
      headers,
      json: {
        products: products.map((productReference) => ({
          productReference,
          containsAlcohol: f.alcohol.has(productReference),
          version: f.alcohol.has(productReference) ? 1 : 0,
        })),
      },
    });
  });
  const optionSetRow = () => {
    const group = groups[0] as (typeof groups)[number];
    return {
      optionSetReference: group.optionSetReference,
      internalCode: "TOPPINGS",
      aggregateVersion: 2,
      archived: false,
      productNames: [],
      name: group.name,
      nameZh: "",
      kind: "Any",
      minimum: 0,
      maximum: null,
      perOptionMaximum: 1,
      updatedAt: at,
      options: group.options.map((option) => ({
        optionReference: option.optionReference,
        code: "TEST",
        name: option.name,
        nameZh: "",
        offered: option.offered,
        defaultChoice: false,
      })),
    };
  };
  await page.route("**/merchant/commerce/option-sets/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-OPTIONSET-EDIT",
        sourceAsOf: at,
        permissions: { mayEdit: true },
        optionSet: optionSetRow(),
      },
    }),
  );
  await page.route("**/merchant/commerce/option-sets/command", (route) => {
    const body = route.request().postDataJSON() as {
      name: string;
      options: { name: string; optionReference?: string | null }[];
    } & Record<string, unknown>;
    f.groupCommands.push(body);
    if (body.action === "Save") {
      const group = groups[0] as (typeof groups)[number];
      group.options = body.options.map((option, n) => ({
        optionReference: option.optionReference ?? id(950 + n),
        name: option.name,
        offered: true,
      }));
      return route.fulfill({ headers, json: { status: "Applied", optionSet: optionSetRow() } });
    }
    const optionSetReference = id(900 + f.groupCommands.length);
    groups.push({
      optionSetReference,
      name: body.name,
      archived: false,
      comboPart: false,
      displayStyle: "MultiSelect",
      minimum: 0,
      maximum: (body.maximum as number | null) ?? null,
      perOptionMaximum: 1,
      options: body.options.map((option, n) => ({
        optionReference: id(920 + n),
        name: option.name,
        offered: true,
      })),
    });
    return route.fulfill({
      headers,
      json: { status: "Applied", optionSet: { optionSetReference } },
    });
  });
  return f;
}

const openNewDish = async (page: Page): Promise<Locator> => {
  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "New dish" }).click();
  const form = page.getByRole("form", { name: "New dish" });
  await expect(form.getByLabel("English name")).toBeVisible();
  return form;
};
const tick = (form: Locator) =>
  form.getByRole("checkbox", { name: "I checked every allergen of this dish." });
const lastCommand = (f: Fixture) => f.dishCommands.at(-1) as Record<string, unknown>;

test("@production a choice starts from its usual extra; a combo's parts are not offered; extras typed in a new group reach the dish", async ({
  page,
}) => {
  await setUp(page);
  const form = await openNewDish(page);
  // A combo's part and an archived group are not choices a dish offers.
  await expect(form.getByRole("checkbox", { name: "Combo drink part" })).toHaveCount(0);
  await expect(form.getByRole("checkbox", { name: "Old promotion" })).toHaveCount(0);
  await form.getByRole("checkbox", { name: "Toppings" }).check();
  await expect(form.getByLabel("Extra ($) for Pearls")).toHaveValue("0.80");
  await expect(form.getByLabel("Extra ($) for Pudding")).toHaveValue("1.20");
  await expect(form.getByLabel("Extra ($) for Cheese foam")).toHaveValue("0.00");
  // One note for the group, not one per choice.
  await expect(form.getByText("No usual price yet", { exact: false })).toHaveCount(1);
  // Unticking and ticking a choice starts from its usual extra again.
  await form.getByRole("checkbox", { name: "Pudding" }).uncheck();
  await form.getByRole("checkbox", { name: "Pudding" }).check();
  await expect(form.getByLabel("Extra ($) for Pudding")).toHaveValue("1.20");

  // Item 3b and item 3 D, in the quick form: limits with the rule guests get, extras typed once.
  await form.getByRole("button", { name: "New choice group" }).click();
  const made = form.getByRole("group", { name: "New choice group" });
  await made.getByLabel("Group name (English)").fill("Sauces");
  await made.getByRole("radio", { name: "Any number, or none" }).check();
  await made.getByLabel("Up to this many in total (empty for no limit)").fill("3");
  await expect(made.getByText("Customers see:", { exact: false })).toContainText("up to 3");
  await made.getByLabel("Choice 1 (English)").fill("Chili");
  await made.getByLabel("Choice 1 extra ($)").fill("0.50");
  // Enter in a choice goes to the next one and adds one at the end; it never saves the dish.
  await made.getByLabel("Choice 1 (English)").press("Enter");
  await expect(made.getByLabel("Choice 2 (English)")).toBeFocused();
  await made.getByLabel("Choice 2 (English)").fill("Garlic");
  await made.getByLabel("Choice 2 (English)").press("Enter");
  await expect(made.getByLabel("Choice 3 (English)")).toBeFocused();
  await made.getByLabel("Choice 2 extra ($)").fill("oops");
  await made.getByRole("button", { name: "Make the group" }).click();
  await expect(made.getByRole("alert")).toContainText("Enter each extra like 0.80");
  await made.getByLabel("Choice 2 extra ($)").fill("0.25");
  await made.getByRole("button", { name: "Make the group" }).click();
  await expect(form.getByRole("checkbox", { name: "Sauces" })).toBeChecked();
  await expect(form.getByLabel("Extra ($) for Chili")).toHaveValue("0.50");
  await expect(form.getByLabel("Extra ($) for Garlic")).toHaveValue("0.25");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/dish-setup-first-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await new AxeBuilder({ page }).include(".one-menu").analyze()).violations).toEqual([]);
  await expectNoInternalText(page);
});

test("@production Enter saves only from the names and price; in an extra it moves on, and pinyin is left alone", async ({
  page,
}) => {
  const f = await setUp(page);
  const form = await openNewDish(page);
  await form.getByLabel("English name").fill("Oolong (TEST)");
  await form.getByLabel("Price ($)").fill("5.00");
  await form.getByRole("checkbox", { name: "Toppings" }).check();
  await form.getByLabel("Extra ($) for Pearls").press("Enter");
  await expect(form.getByLabel("Extra ($) for Pudding")).toBeFocused();
  await form.getByRole("checkbox", { name: "Toppings" }).press("Enter");
  // Enter committing pinyin belongs to the input method (Safari reports keyCode 229).
  await form.getByLabel("Chinese name").focus();
  await form.getByLabel("Chinese name").evaluate((input) => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
    );
  });
  expect(f.dishCommands).toEqual([]);
  // From the name, Enter saves.
  await form.getByLabel("English name").press("Enter");
  await expect(page.getByText("Oolong (TEST) saved.", { exact: false })).toBeVisible();
  expect(lastCommand(f)).toMatchObject({ name: "Oolong (TEST)", allergens: null });
});

test("@production Same as copies choices and marks, never the name, price or kind; only the tick confirms copied allergens", async ({
  page,
}) => {
  const f = await setUp(page);
  const source = f.dishes[0] as Dish;
  f.kitchenSection.set(source.product, stirFry);
  f.alcohol.add(source.product);
  f.explicitMarks.set(source.product, true);
  const form = await openNewDish(page);
  const sameAs = form.getByLabel("Same as");
  // A fee is never copied; dishes are grouped by section with both names.
  await expect(sameAs.getByRole("option", { name: "Corkage (TEST) 开瓶费" })).toHaveCount(0);
  await sameAs.selectOption({ label: "Milk tea (TEST) 奶茶" });
  await expect(form.getByText("Copied from Milk tea (TEST)", { exact: false })).toBeVisible();
  // Each group folds to one line, every extra showing; an archived group is left behind.
  await expect(form.locator(".dish-editor__group .dish-editor__carried").first()).toContainText(
    "Toppings: Pearls +0.80, Pudding +1.20",
  );
  await expect(form.locator(".dish-editor__group .dish-editor__carried").nth(1)).toContainText(
    "Size: Medium +0.00, Large +1.00",
  );
  await expect(form.getByLabel("English name")).toHaveValue("");
  await expect(form.getByLabel("Price ($)")).toHaveValue("");
  await expect(form.getByRole("combobox", { name: "Section", exact: true })).toHaveValue("DRINKS");
  // Its kitchen section and marks are on the form, each on one line that opens.
  await expect(form.getByText("Kitchen: Not prepared by the kitchen · Bar (TEST)")).toBeVisible();
  await expect(form.getByText("Alcohol: Contains alcohol")).toBeVisible();
  await form.getByRole("button", { name: "Change kitchen" }).click();
  await expect(form.getByRole("combobox", { name: "Kitchen section" })).toHaveValue(stirFry);
  await expect(form.getByRole("checkbox", { name: /Not prepared by the kitchen/u })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: /Contains alcohol/u })).toBeChecked();
  // The allergens are there but not confirmed, and changing one does not confirm the rest.
  await expect(form.locator(".dish-editor__summary")).toContainText("Contains Milk.");
  await expect(tick(form)).not.toBeChecked();
  await form.getByRole("button", { name: "Change allergens" }).click();
  await form.getByRole("radiogroup", { name: "Soy" }).getByLabel("May contain").check();
  await expect(tick(form)).not.toBeChecked();
  await expect(form.locator(".dish-editor__summary")).toContainText(
    "Contains Milk. May contain Soy.",
  );
  await form.getByLabel("English name").fill("Taro tea (TEST)");
  await form.getByLabel("Price ($)").fill("6.20");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/dish-setup-copied-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await new AxeBuilder({ page }).include(".one-menu").analyze()).violations).toEqual([]);
  await expectNoInternalText(page);
  // Enter from the name does not add the next one until the tick is on: the form stays filled.
  await form.getByLabel("Price ($)").press("Enter");
  await expect(form.getByRole("button", { name: "Save and add another" })).toBeDisabled();
  await expect(form.getByText("Check the allergens to add the next one")).toBeVisible();
  await expect(form.getByLabel("English name")).toHaveValue("Taro tea (TEST)");
  expect(f.dishCommands).toEqual([]);
  // WP-2423 (M76, Owner decision 16): copied allergens are not a declaration, and the dish is not
  // saved with its allergens left for later. Ticked, the save declares every row.
  await expect(form.getByRole("button", { name: "Save dish" })).toBeDisabled();
  await expect(form.getByText("Tick the allergen check to save.")).toBeVisible();
  await tick(form).check();
  await form.getByRole("button", { name: "Save dish" }).click();
  await expect(
    page.getByText("Taro tea (TEST) saved. Guests see it when the menu is listed."),
  ).toBeVisible();
  expect(lastCommand(f)).toMatchObject({
    productReference: null,
    name: "Taro tea (TEST)",
    priceMinor: "620",
    sectionCode: "DRINKS",
    allergens: expect.arrayContaining([
      expect.objectContaining({ classification: "Contains" }),
      expect.objectContaining({ classification: "CrossContactPossible" }),
    ]),
    choiceGroups: [
      {
        optionSetReference: toppings,
        options: [
          { optionReference: pearls, amountMinor: "80" },
          { optionReference: pudding, amountMinor: "120" },
        ],
      },
      {
        optionSetReference: size,
        options: [
          { optionReference: medium, amountMinor: "0" },
          { optionReference: large, amountMinor: "100" },
        ],
      },
    ],
  });
  const saved = f.dishes.at(-1) as Dish;
  // Its marks were set right after the save, on the new dish.
  expect(f.markCommands.at(-1)).toMatchObject({
    productReference: saved.product,
    expectedVersion: 0,
    notPrepared: true,
  });
  expect(f.sectionCommands.at(-1)).toMatchObject({
    productReference: saved.product,
    expectedVersion: 0,
    sectionReference: stirFry,
  });
  expect(f.alcoholCommands.at(-1)).toMatchObject({
    productReference: saved.product,
    expectedVersion: 0,
    containsAlcohol: true,
  });
});

test("@production Save and add another keeps the form and resets the names; the kind goes back to a dish; a menu read failure keeps the form", async ({
  page,
}) => {
  const f = await setUp(page);
  const form = await openNewDish(page);
  const addAnother = form.getByRole("button", { name: "Save and add another" });
  await form.getByLabel("English name").fill("Tsingtao (TEST)");
  await form.getByLabel("Chinese name").fill("青岛啤酒");
  await form.getByLabel("English description").fill("Bottled");
  await form.getByLabel("Price ($)").fill("7.00");
  await form.getByRole("checkbox", { name: "Size" }).check();
  await form
    .getByRole("combobox", { name: "Kitchen section" })
    .selectOption({ label: "Bar (TEST)" });
  await form.getByRole("checkbox", { name: /Contains alcohol/u }).check();
  await expect(addAnother).toBeDisabled();
  await form.getByRole("radiogroup", { name: "Wheat" }).getByLabel("Contains").check();
  // WP-2423 (M76): the other rows are still unanswered, so nothing is confirmed and the save waits.
  await expect(tick(form)).toBeDisabled();
  await expect(addAnother).toBeDisabled();
  await expect(form.getByRole("button", { name: "Save dish" })).toBeDisabled();
  await expect(form.getByText("A row left blank is never taken as No.")).toBeVisible();
  await form.getByRole("radiogroup", { name: "Milk" }).getByLabel("No").check();
  await form.getByRole("radiogroup", { name: "Soy" }).getByLabel("No").check();
  // The last allergen answered ticks the confirmation.
  await expect(tick(form)).toBeChecked();
  await addAnother.click();
  await expect(form.locator(".dish-editor__result")).toContainText(
    "Tsingtao (TEST) saved. Guests see it when the menu is listed. Added 1.",
  );
  await expect(form.getByLabel("English name")).toBeFocused();
  await expect(form.getByLabel("English name")).toHaveValue("");
  await expect(form.getByLabel("Chinese name")).toHaveValue("");
  await form.getByRole("button", { name: "Add descriptions" }).click();
  await expect(form.getByLabel("English description")).toHaveValue("");
  await expect(form.getByLabel("Price ($)")).toHaveValue("");
  await expect(tick(form)).not.toBeChecked();
  await expect(form.locator(".dish-editor__group .dish-editor__carried")).toContainText(
    "Size: Medium +0.00, Large +1.00",
  );
  // The allergens stay on the form to be checked again; the kitchen section and the mark stay.
  await expect(form.locator(".dish-editor__summary")).toContainText("Contains Wheat.");
  await expect(form.getByText("Kitchen: Goes to the kitchen · Bar (TEST)")).toBeVisible();
  await expect(form.getByText("Alcohol: Contains alcohol")).toBeVisible();
  const first = f.dishes.at(-1) as Dish;
  expect(f.alcoholCommands.at(-1)).toMatchObject({ productReference: first.product });
  expect(f.sectionCommands.at(-1)).toMatchObject({ productReference: first.product });
  // The next drink fits: from its price to the allergen tick is under a screen on a 1024 iPad, and
  // at most two on a phone, with a long menu's rows folded away.
  for (const [width, height, screens] of [
    [1024, 768, 1],
    [390, 844, 2],
  ] as const) {
    await page.setViewportSize({ width, height });
    const price = await form.getByLabel("Price ($)").boundingBox();
    const check = await tick(form).boundingBox();
    expect((check?.y ?? 0) - (price?.y ?? 0)).toBeLessThan(height * screens);
    await page.screenshot({ path: `test-results/dish-setup-carried-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // It shows on the menu behind the form.
  await expect(page.locator(".one-menu__dish").filter({ hasText: "Tsingtao" })).toHaveCount(1);
  // The dish just saved heads the "Same as" list.
  await expect(form.getByLabel("Same as").locator("optgroup").first()).toHaveAttribute(
    "label",
    "Last saved",
  );
  // Enter without the tick does not clear the form.
  await form.getByLabel("English name").fill("Corona (TEST)");
  await form.getByLabel("Price ($)").fill("7.50");
  await form.getByLabel("Price ($)").press("Enter");
  await expect(form.getByText("Check the allergens to add the next one")).toBeVisible();
  await expect(form.getByLabel("English name")).toHaveValue("Corona (TEST)");
  const saves = f.dishCommands.length;
  expect(saves).toBe(1);
  // With it, Enter does what the button does. A menu read failing behind the form leaves it open.
  await tick(form).check();
  f.failMenuReads = 2;
  await form.getByLabel("Price ($)").press("Enter");
  await expect(form.locator(".dish-editor__result")).toContainText("Added 2.");
  await expect(page.getByText("The menu could not be read again.", { exact: false })).toBeVisible();
  await expect(form.getByLabel("English name")).toHaveValue("");
  f.failMenuReads = 0;
  await page.getByRole("button", { name: "Read again" }).click();
  await expect(page.getByText("The menu could not be read again.", { exact: false })).toHaveCount(
    0,
  );
  await expect(page.locator(".one-menu__dish").filter({ hasText: "Corona" })).toHaveCount(1);

  // After a fee, the next item is a dish and is asked for its allergens.
  await form.getByLabel("English name").fill("Bag fee (TEST)");
  await form.getByLabel("Price ($)").fill("0.25");
  await form
    .getByRole("radio", {
      name: "A fee, not food (tea, corkage, sauce bar): no allergens, never goes to the kitchen",
    })
    .check();
  await expect(form.getByText("A charge does not go to the kitchen.")).toBeVisible();
  await expect(tick(form)).toHaveCount(0);
  await addAnother.click();
  await expect(form.locator(".dish-editor__result")).toContainText("Added 3.");
  expect(lastCommand(f)).toMatchObject({ name: "Bag fee (TEST)", allergens: "NoIngredients" });
  await expect(form.getByRole("radio", { name: "A dish: declare its allergens" })).toBeChecked();
  await expect(tick(form)).not.toBeChecked();
  await expect(form.getByText("Kitchen: Goes to the kitchen · Bar (TEST)")).toBeVisible();
  // The fee can't be copied: it is not in the list.
  await expect(form.getByLabel("Same as").getByRole("option", { name: /Bag fee/u })).toHaveCount(0);
  await form.getByRole("button", { name: "Close" }).click();
  // The banner counts what the filter shows.
  const banner = page.getByText("1 dish still needs allergens");
  await expect(banner).toBeVisible();
  await page.getByRole("button", { name: "Show them" }).click();
  await expect(page.locator(".one-menu__dish .one-menu__name")).toHaveText(["Coffee (TEST)"]);
  await expect(
    page.getByRole("group", { name: "Show only" }).getByRole("button", {
      name: "Allergens not declared",
    }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("@production a Brand with no allergen list yet can still add one dish after another", async ({
  page,
}) => {
  const f = await setUp(page, { allergenList: false });
  const form = await openNewDish(page);
  await form.getByLabel("English name").fill("Oolong (TEST)");
  await form.getByLabel("Price ($)").fill("5.00");
  await form.getByRole("button", { name: "Save and add another" }).click();
  await expect(form.locator(".dish-editor__result")).toContainText("Added 1. 1 needs allergens.");
  await form.getByLabel("English name").fill("Black tea (TEST)");
  await form.getByLabel("Price ($)").fill("5.00");
  await form.getByRole("button", { name: "Save and add another" }).click();
  await expect(form.locator(".dish-editor__result")).toContainText("Added 2. 2 need allergens.");
  expect(f.dishCommands).toHaveLength(2);
});

test("@production a save that stopped after the dish was made goes on as an edit of it, with a fresh operation", async ({
  page,
}) => {
  const f = await setUp(page);
  const product = id(7777);
  f.dishes.push({
    ...dish("Made already (TEST)", "", "DRINKS", null, { source: "None", declared: [] }),
    product,
  });
  f.failSaves.push({
    status: 409,
    json: { error: "StoppedPartWay", part: "OneStoreDish", productReference: product },
  });
  const form = await openNewDish(page);
  await form.getByLabel("English name").fill("Made already (TEST)");
  await form.getByLabel("Price ($)").fill("5.00");
  await form.getByRole("button", { name: "Save dish" }).click();
  await expect(form.getByRole("alert")).toContainText("Saving stopped part-way.");
  await form.getByRole("button", { name: "Save dish" }).click();
  await expect(page.getByText("Made already (TEST) saved.", { exact: false })).toBeVisible();
  const [firstSave, secondSave] = f.dishCommands as [
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  expect(firstSave.productReference).toBeNull();
  expect(secondSave.productReference).toBe(product);
  expect(secondSave.operationReference).not.toBe(firstSave.operationReference);
  // The price the owner typed is still sent: the dish has none yet.
  expect(secondSave.priceMinor).toBe("500");
  expect(f.dishes.filter((d) => d.name === "Made already (TEST)")).toHaveLength(1);
});

test("@production Use on other dishes adds what is missing, asks about allergens and confirms money, and carries on", async ({
  page,
}) => {
  const f = await setUp(page);
  const milkTea = f.dishes[0] as Dish;
  const fruitTea = f.dishes[2] as Dish;
  const coffee = f.dishes[3] as Dish;
  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "Edit Milk tea (TEST) 奶茶" }).click();
  const form = page.getByRole("form", { name: "Milk tea (TEST) 奶茶" });
  await expect(form.getByLabel("English name")).toHaveValue("Milk tea (TEST)");
  // Its price is not sent back unless it is edited.
  await form.getByRole("checkbox", { name: "Cheese foam" }).check();
  await form.getByLabel("Extra ($) for Cheese foam").fill("1.50");
  await form.getByRole("button", { name: "Use Toppings on other dishes" }).click();
  const panel = form.getByRole("group", { name: "Use Toppings on other dishes" });
  await expect(panel.getByRole("checkbox", { name: "Fruit tea (TEST) 果茶" })).toBeVisible();
  // A fee and this dish are not offered; a dish from a recipe is, and is named.
  await expect(panel.getByRole("checkbox", { name: /Corkage/u })).toHaveCount(0);
  await expect(panel.getByRole("checkbox", { name: /Milk tea/u })).toHaveCount(0);
  await panel.getByRole("checkbox", { name: "All in this section" }).first().check();
  await expect(panel.getByRole("checkbox", { name: "Coffee (TEST) 咖啡" })).toBeChecked();
  const apply = panel.getByRole("button", { name: "Apply to 2 dishes" });
  // The question is required.
  await expect(apply).toBeDisabled();
  const question = panel.getByRole("group", {
    name: "Does Cheese foam contain anything on your allergen list?",
  });
  await expect(panel.getByText("Does Pearls contain", { exact: false })).toBeVisible();
  await panel
    .getByRole("group", { name: "Does Pearls contain anything on your allergen list?" })
    .getByRole("radio", { name: "No" })
    .check();
  await panel
    .getByRole("group", { name: "Does Pudding contain anything on your allergen list?" })
    .getByRole("radio", { name: "No" })
    .check();
  await question.getByRole("radio", { name: "Yes" }).check();
  await expect(apply).toBeDisabled();
  await question.getByRole("radiogroup", { name: "Milk" }).getByLabel("Contains").check();
  await expect(apply).toBeEnabled();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/dish-setup-apply-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await new AxeBuilder({ page }).include(".one-menu").analyze()).violations).toEqual([]);
  await expectNoInternalText(page);

  // The run stops at the first failure, naming the dish, and carries on with one operation.
  const before = fruitTea.chosen.get(size)?.get(large);
  f.failSaves.push(null, { status: 409, json: { error: "StoppedPartWay", part: "OneStoreDish" } });
  await apply.click();
  await expect(panel.getByRole("alert")).toContainText("Stopped at Fruit tea (TEST) 果茶.");
  const stoppedSave = f.dishCommands.at(-1) as Record<string, unknown>;
  expect(stoppedSave).toMatchObject({
    productReference: fruitTea.product,
    priceMinor: null,
    sectionCode: null,
    allergens: [
      { allergenReference: soy, classification: "CrossContactPossible" },
      { allergenReference: milk, classification: "Contains" },
      { allergenReference: wheat, classification: "None" },
    ],
  });
  await panel.getByRole("button", { name: "Try again" }).click();
  // Coffee has no allergens declared yet: named at the end, not counted as done.
  await expect(
    page.getByText("Applied to 2 dishes. Guests see it when the menu is listed.", { exact: false }),
  ).toBeVisible();
  // This dish was saved first, then each of the others, the stopped one with the same operation.
  expect(f.dishCommands.map((c) => c.productReference)).toEqual([
    milkTea.product,
    fruitTea.product,
    fruitTea.product,
    coffee.product,
  ]);
  expect(f.dishCommands[2]?.operationReference).toBe(stoppedSave.operationReference);
  expect(f.dishCommands[0]).toMatchObject({ priceMinor: null, productReference: milkTea.product });
  // Added at this dish's extra; another dish's Large stays as it was.
  expect(fruitTea.chosen.get(toppings)?.get(foam)).toBe("150");
  expect(fruitTea.chosen.get(toppings)?.get(pearls)).toBe("90");
  expect(fruitTea.chosen.get(size)?.get(large)).toBe(before);
  // A dish not declared yet stays waiting rather than being declared for the owner.
  expect(f.dishCommands[3]?.allergens).toBeNull();
  await expect(page.getByText("Still waiting for allergens: Coffee (TEST) 咖啡.")).toBeVisible();

  // After a reload "has it" shows what is done, and a new run touches only the rest.
  await page.reload();
  await page.getByRole("button", { name: "Edit Milk tea (TEST) 奶茶" }).click();
  await form.getByRole("button", { name: "Use Toppings on other dishes" }).click();
  await expect(
    panel.getByRole("listitem").filter({ hasText: "Fruit tea" }).getByText("has it"),
  ).toBeVisible();
  await form.getByRole("button", { name: "Not now" }).click();
  await form.getByRole("button", { name: "Close" }).click();
});

test("@production changing existing extras is asked for, dish by dish, and the money is confirmed", async ({
  page,
}) => {
  const f = await setUp(page);
  const fruitTea = f.dishes[2] as Dish;
  const third = dish(
    "Oat latte (TEST)",
    "燕麦拿铁",
    "DRINKS",
    "650",
    {
      source: "StaffDeclared",
      declared: [],
    },
    [[size, [[large, "120"]]]],
  );
  f.dishes.push(third);
  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "Edit Milk tea (TEST) 奶茶" }).click();
  const form = page.getByRole("form", { name: "Milk tea (TEST) 奶茶" });
  await form.getByLabel("Extra ($) for Large").fill("1.25");
  await form.getByRole("button", { name: "Use Size on other dishes" }).click();
  const panel = form.getByRole("group", { name: "Use Size on other dishes" });
  await panel.getByRole("checkbox", { name: "Fruit tea (TEST) 果茶" }).check();
  await panel.getByRole("checkbox", { name: "Oat latte (TEST) 燕麦拿铁" }).check();
  // Both have Large already, one at a different extra; by default nothing changes on them, and
  // the Medium they don't have is added at this dish's extra.
  const medium0 = panel.getByRole("group", {
    name: "Does Medium contain anything on your allergen list?",
  });
  await medium0.getByRole("radio", { name: "No" }).check();
  await expect(panel.getByText("Medium adds nothing", { exact: false })).toBeVisible();
  await panel.getByRole("checkbox", { name: /Also change this extra/u }).check();
  // One line a dish, and a dish can be left out.
  await expect(panel.getByText("Fruit tea (TEST) 果茶: Large $1.50 to $1.25")).toBeVisible();
  await expect(panel.getByText("Oat latte (TEST) 燕麦拿铁: Large $1.20 to $1.25")).toBeVisible();
  await panel.getByRole("checkbox", { name: /Oat latte \(TEST\) 燕麦拿铁: Large/u }).uncheck();
  await panel.getByRole("button", { name: "Apply to 2 dishes" }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "This changes the extra price on 1 dish: Large $1.50 to $1.25. Guests see it when the menu is listed.",
  );
  expect(f.dishCommands).toEqual([]);
  await panel.getByRole("button", { name: "Go back" }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await panel.getByRole("button", { name: "Apply to 2 dishes" }).click();
  await panel.getByRole("button", { name: "Change these prices" }).click();
  await expect(page.getByText("Applied to 3 dishes.", { exact: false })).toBeVisible();
  expect(fruitTea.chosen.get(size)?.get(large)).toBe("125");
  expect(fruitTea.chosen.get(size)?.get(medium)).toBe("0");
  expect(third.chosen.get(size)?.get(large)).toBe("120");
  expect(third.chosen.get(size)?.get(medium)).toBe("0");
});

test("@production a store that keeps stock reaches other dishes through option recipes", async ({
  page,
}) => {
  await setUp(page, { keepsStock: true });
  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "Edit Milk tea (TEST) 奶茶" }).click();
  const form = page.getByRole("form", { name: "Milk tea (TEST) 奶茶" });
  await expect(form.getByLabel("English name")).toHaveValue("Milk tea (TEST)");
  await expect(form.getByRole("button", { name: /on other dishes/u })).toHaveCount(0);
  await expect(form.getByRole("link", { name: "Open option recipes" })).toHaveAttribute(
    "href",
    "/app/commerce/option-recipes",
  );
});

test("@production a new choice on a group leads to the first dish using it, ticked, with the list open", async ({
  page,
}) => {
  const f = await setUp(page);
  // On a phone the page is long: the prompt and the new extra must still be where the owner is.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/commerce/option-sets/" + toppings);
  await page.getByRole("button", { name: "Add option" }).click();
  await page.getByRole("textbox", { name: "Option 4 name" }).fill("Coconut jelly");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Coconut jelly is not on any dish yet.")).toBeInViewport();
  await expectNoInternalText(page);
  await page.getByRole("link", { name: "Add it to dishes" }).click();
  const form = page.getByRole("form", { name: "Milk tea (TEST) 奶茶" });
  await expect(form.getByRole("checkbox", { name: "Coconut jelly" })).toBeChecked();
  const extra = form.getByLabel("Extra ($) for Coconut jelly");
  await expect(extra).toHaveValue("0.00");
  await expect(extra).toBeFocused();
  await expect(extra).toBeInViewport();
  await expect(form.getByRole("group", { name: "Use Toppings on other dishes" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  // Nothing identifying the group travels in the address, and a reload does not open it again.
  expect(new URL(page.url()).pathname).toBe("/app/commerce/menus");
  expect(new URL(page.url()).search).toBe("");
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit Milk tea (TEST) 奶茶" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Milk tea (TEST) 奶茶" })).toHaveCount(0);
  void f;
});

test("@production no dish uses the group yet: the menu says what to do", async ({ page }) => {
  const f = await setUp(page);
  for (const entry of f.dishes) entry.chosen.delete(toppings);
  await page.goto("/app/commerce/option-sets/" + toppings);
  await page.getByRole("button", { name: "Add option" }).click();
  await page.getByRole("textbox", { name: "Option 4 name" }).fill("Coconut jelly");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("link", { name: "Add it to dishes" }).click();
  await expect(
    page.getByText("Coconut jelly is not on any dish yet, and no dish uses its group.", {
      exact: false,
    }),
  ).toBeVisible();
});

test("@production with two menus, a new choice says which dishes to open instead of a blank list", async ({
  page,
}) => {
  await setUp(page, { secondMenu: true });
  await page.goto("/app/commerce/option-sets/" + toppings);
  await page.getByRole("button", { name: "Add option" }).click();
  await page.getByRole("textbox", { name: "Option 4 name" }).fill("Coconut jelly");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("link", { name: "Add it to dishes" }).click();
  await expect(page.getByRole("link", { name: "TEST dinner" })).toBeVisible();
  await expect(
    page.getByText(
      "Coconut jelly is not on any dish yet. Open a dish that uses Toppings and tick it.",
    ),
  ).toBeVisible();
  await expectNoInternalText(page);
  // Said once: a reload shows the plain list.
  expect(new URL(page.url()).search).toBe("");
  await page.reload();
  await expect(page.getByRole("link", { name: "TEST dinner" })).toBeVisible();
  await expect(
    page.getByText("Coconut jelly is not on any dish yet.", { exact: false }),
  ).toHaveCount(0);
});

test("@production a listing stopped by a dish with no allergens points to those dishes", async ({
  page,
}) => {
  const f = await setUp(page);
  f.failSaves.push({
    status: 409,
    json: {
      error: "ReviewBlocked",
      part: "Menu",
      problem: {
        missing: "Recipe",
        productName: "Coffee (TEST)",
        sizeName: null,
        optionName: null,
        quantity: null,
        ingredientName: null,
        // The listing names the Store as it does for a recipe assigned elsewhere.
        storeName: "Synthetic Store",
      },
    },
  });
  await page.goto("/app/commerce/menus");
  // WP-2423 M69: "List it" shows what goes live first and names the dish with no allergens.
  await page.getByRole("button", { name: "List it" }).click();
  const review = page.getByRole("region", { name: "What goes live" });
  await expect(review.getByText("Answer allergens for 1 dish first: Coffee (TEST).")).toBeVisible();
  await review.getByRole("button", { name: "List it" }).click();
  const refusal = page.getByText("Coffee (TEST) has no allergens answered.", { exact: false });
  await expect(refusal).toBeVisible();
  await expect(page.getByText("as a charge", { exact: false })).toHaveCount(0);
  await expect(page.getByText("assign its recipe", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Show dishes without allergens" }).click();
  await expect(page.locator(".one-menu__dish .one-menu__name")).toHaveText(["Coffee (TEST)"]);
  // A save part-way through a listing says to list it again.
  f.failSaves.push({ status: 409, json: { error: "StoppedPartWay", part: "OneStoreDish" } });
  await page.getByRole("button", { name: "List it" }).click();
  await page
    .getByRole("region", { name: "What goes live" })
    .getByRole("button", { name: "List it" })
    .click();
  await expect(
    page.getByText(
      "Listing stopped part-way. New prices may already be showing to guests; the menu is not updated yet. List it again to finish.",
    ),
  ).toBeVisible();
});

test("@production Start empty after a copy takes away what the copy brought and keeps what was typed", async ({
  page,
}) => {
  const f = await setUp(page);
  const source = f.dishes[0] as Dish;
  f.alcohol.add(source.product);
  const form = await openNewDish(page);
  await form.getByLabel("English name").fill("Plain tea (TEST)");
  const sameAs = form.getByLabel("Same as");
  await sameAs.selectOption({ label: "Milk tea (TEST) 奶茶" });
  await expect(form.getByText("Copied from Milk tea (TEST)", { exact: false })).toBeVisible();
  await expect(form.getByText("Alcohol: Contains alcohol")).toBeVisible();
  await sameAs.selectOption({ label: "Start empty" });
  await expect(form.getByText("Copied from Milk tea (TEST)", { exact: false })).toHaveCount(0);
  await expect(form.locator(".dish-editor__group .dish-editor__carried")).toHaveCount(0);
  await expect(form.getByRole("checkbox", { name: "Toppings", exact: true })).not.toBeChecked();
  await expect(form.getByRole("checkbox", { name: "Size", exact: true })).not.toBeChecked();
  await expect(form.getByRole("checkbox", { name: /Contains alcohol/u })).not.toBeChecked();
  await expect(form.getByLabel("English name")).toHaveValue("Plain tea (TEST)");
  await form.getByLabel("Price ($)").fill("3.50");
  await form.getByRole("button", { name: "Save dish" }).click();
  await expect(page.getByText("Plain tea (TEST) saved.", { exact: false })).toBeVisible();
  expect(lastCommand(f)).toMatchObject({ choiceGroups: [], allergens: null, priceMinor: "350" });
  expect(f.alcoholCommands).toEqual([]);
});

test("@production the dish on screen gains the allergens given for a choice it passes on", async ({
  page,
}) => {
  const f = await setUp(page);
  const fruitTea = f.dishes[2] as Dish;
  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "Edit Fruit tea (TEST) 果茶" }).click();
  const form = page.getByRole("form", { name: "Fruit tea (TEST) 果茶" });
  await expect(form.getByLabel("English name")).toHaveValue("Fruit tea (TEST)");
  await form.getByRole("checkbox", { name: "Cheese foam" }).check();
  await form.getByLabel("Extra ($) for Cheese foam").fill("1.50");
  await form.getByRole("button", { name: "Use Toppings on other dishes" }).click();
  const panel = form.getByRole("group", { name: "Use Toppings on other dishes" });
  await panel.getByRole("checkbox", { name: "Milk tea (TEST) 奶茶" }).check();
  const question = panel.getByRole("group", {
    name: "Does Cheese foam contain anything on your allergen list?",
  });
  await question.getByRole("radio", { name: "Yes" }).check();
  await question.getByRole("radiogroup", { name: "Milk" }).getByLabel("Contains").check();
  await panel.getByRole("button", { name: /Apply to/u }).click();
  await expect(page.getByText("Applied to 2 dishes.", { exact: false })).toBeVisible();
  // Fruit tea now offers cheese foam, so it declares milk too, keeping what it had; every other
  // allergen on the list is answered No (WP-2423 M76), in the list's order.
  expect(f.dishCommands[0]).toMatchObject({
    productReference: fruitTea.product,
    allergens: [
      { allergenReference: milk, classification: "Contains" },
      { allergenReference: soy, classification: "CrossContactPossible" },
      { allergenReference: wheat, classification: "None" },
    ],
  });
});

test("@production a price put back after a save stopped part-way is sent, not taken as unchanged", async ({
  page,
}) => {
  const f = await setUp(page);
  const milkTea = f.dishes[0] as Dish;
  await page.goto("/app/commerce/menus");
  await page.getByRole("button", { name: "Edit Milk tea (TEST) 奶茶" }).click();
  const form = page.getByRole("form", { name: "Milk tea (TEST) 奶茶" });
  await expect(form.getByLabel("English name")).toHaveValue("Milk tea (TEST)");
  await form.getByLabel("Price ($)").fill("6.00");
  f.failSaves.push({
    status: 409,
    json: { error: "StoppedPartWay", part: "OneStoreDish", productReference: milkTea.product },
  });
  await form.getByRole("button", { name: "Save dish" }).click();
  await expect(form.getByRole("alert")).toContainText("Saving stopped part-way");
  expect(lastCommand(f).priceMinor).toBe("600");
  // The stopped save may already have set 6.00, so 5.50 put back is sent.
  await form.getByLabel("Price ($)").fill("5.50");
  await form.getByRole("button", { name: "Save dish" }).click();
  await expect(page.getByText("Milk tea (TEST) saved.", { exact: false })).toBeVisible();
  expect(f.dishCommands).toHaveLength(2);
  expect(lastCommand(f).priceMinor).toBe("550");
});

test("@production a dish saved without its allergens is told to declare them before listing", async ({
  page,
}) => {
  const f = await setUp(page);
  const form = await openNewDish(page);
  await form.getByLabel("English name").fill("Steamed rice (TEST)");
  await form.getByLabel("Price ($)").fill("3.00");
  await form.getByRole("button", { name: "Save dish" }).click();
  await expect(
    page.getByText("Steamed rice (TEST) saved. Declare its allergens, then list it."),
  ).toBeVisible();
  expect(lastCommand(f)).toMatchObject({ allergens: null, choiceGroups: [] });
});
