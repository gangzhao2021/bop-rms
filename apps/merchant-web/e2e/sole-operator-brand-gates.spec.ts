import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 Q19 step 2 (DEC-SOLE-OPERATOR-APPROVAL): Brand gates — the author publishing their own
// price book alone as sole operator, and the allergen list recorded by one person and approved by
// another (or by its recorder alone as sole operator).
const id = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const owner = id(4);
async function session(page: Page, navigation: unknown[]) {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [
            { brandLabel: scope.brandLabel, storeLabel: scope.storeLabel, storeReference: id(99) },
          ],
          businessDate: "2026-10-13",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation,
        },
      },
    }),
  );
  const stepUps: string[] = [];
  let validUntil: string | null = null;
  await page.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ headers, json: { validUntil } });
    stepUps.push(route.request().postData() ?? "");
    const at = Date.now();
    validUntil = new Date(at + 15 * 60_000).toISOString();
    return route.fulfill({
      headers,
      json: { status: "Verified", verifiedAt: new Date(at).toISOString(), validUntil },
    });
  });
  return stepUps;
}
async function verify(page: Page, label: string) {
  await page.getByRole("button", { name: label }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
}

test("@production the price book author publishes alone as sole operator after confirming", async ({
  page,
}) => {
  const stepUps = await session(page, [
    {
      screenId: "PRICE-BOOK-LIST",
      label: "Prices",
      href: "/app/commerce/pricing",
      permission: "pricing.price_book.read",
    },
  ]);
  const commands: string[] = [];
  let soleOperator: unknown = { status: "Effective", otherApprovers: [], verifiedUntil: null };
  await page.route("**/merchant/commerce/pricing/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "PRICE-BOOK-EDITOR",
        sourceAsOf: new Date().toISOString(),
        viewer: owner,
        permissions: { mayRead: true, mayEdit: true, mayApprove: true },
        currencyCode: "CAD",
        storeAssignment: null,
        assignmentHistory: [],
        sellables: [
          {
            sellableReference: id(20),
            skuCode: "LATTE-S",
            productReference: id(21),
            productName: "Latte",
            sizeName: "Small",
            active: true,
          },
        ],
        menuSellables: [id(20)],
        book: {
          priceBookReference: id(10),
          versionReference: id(11),
          stableCode: "PRICES-20261013",
          lifecycle: "Draft",
          aggregateVersion: 2,
          createdAt: new Date().toISOString(),
          prices: [{ sellableReference: id(20), amountMinor: "450" }],
          otherEntries: 0,
        },
        draftAuthor: owner,
        soleOperator,
        uncovered: [],
      },
    }),
  );
  await page.route("**/merchant/commerce/pricing/command", (route) => {
    commands.push(route.request().postData() ?? "");
    return route.fulfill({
      headers,
      json: {
        status: "Applied",
        priceBookReference: id(10),
        aggregateVersion: 3,
        lifecycle: "Published",
      },
    });
  });
  await page.goto("/app/commerce/pricing/" + id(10));
  const publish = page.getByRole("button", { name: "Publish on my own" });
  await expect(
    page.getByText("You made this change and you are the only person who holds price approval"),
  ).toBeVisible();
  await expect(
    page.getByText("you may publish your own draft after checking it and verifying it is you"),
  ).toBeVisible();
  await expect(page.getByText("must be done by someone other than")).toHaveCount(0);
  // Prices in staff words: no "(CAD)" column or "prices in CAD".
  await expect(page.getByRole("columnheader", { name: "Price", exact: true })).toBeVisible();
  await expect(page.getByText(/prices before tax, the same for pickup and dine-in/u)).toBeVisible();
  await expectNoInternalText(page);
  await expect(publish).toBeDisabled();
  await verify(page, "Verify to approve on your own");
  expect(JSON.parse(stepUps[0] ?? "{}")).toEqual({
    purpose: "SoleOperatorApproval",
    code: "123456",
  });
  await expect(publish).toBeDisabled();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/sole-operator-price-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("I checked these prices and approve on my own").check();
  await publish.click();
  await expect(page.getByText("Published.")).toBeVisible();
  expect(JSON.parse(commands[0] ?? "{}")).toMatchObject({
    action: "Publish",
    priceBookReference: id(10),
    expectedAggregateVersion: 2,
    approvalMode: "SoleOperator",
  });
  // When someone else holds price approval, the page names them and offers no self-publish.
  soleOperator = {
    status: "OtherApprovers",
    otherApprovers: [{ displayName: "Mia" }],
    verifiedUntil: null,
  };
  await page.reload();
  await expect(
    page.getByText("Sole operator is on, but Mia also holds price approval, so they must approve"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish on my own" })).toHaveCount(0);
});

test("@production the price list shows drafts in Store time and discarding a draft asks first", async ({
  page,
}) => {
  await session(page, [
    {
      screenId: "PRICE-BOOK-LIST",
      label: "Prices",
      href: "/app/commerce/pricing",
      permission: "pricing.price_book.read",
    },
  ]);
  const base = {
    sourceAsOf: "2026-10-14T18:05:00.000Z",
    viewer: owner,
    permissions: { mayRead: true, mayEdit: true, mayApprove: true },
    currencyCode: "CAD",
    storeAssignment: null,
    assignmentHistory: [],
    sellables: [],
    menuSellables: [],
  };
  const draft = {
    priceBookReference: id(10),
    versionReference: id(11),
    stableCode: "PRICES-Q19-TEST",
    lifecycle: "Draft",
    aggregateVersion: 1,
  };
  await page.route("**/merchant/commerce/pricing/query", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      priceBookReference: string | null;
    };
    return route.fulfill({
      headers,
      json:
        body.priceBookReference === null
          ? {
              screenId: "PRICE-BOOK-LIST",
              ...base,
              soleOperator: { status: "Effective", otherApprovers: [], verifiedUntil: null },
              books: [
                {
                  ...draft,
                  entries: 0,
                  createdAt: "2026-10-15T16:30:00.000Z",
                  updatedAt: "2026-10-15T16:30:00.000Z",
                },
              ],
            }
          : {
              screenId: "PRICE-BOOK-EDITOR",
              ...base,
              book: {
                ...draft,
                createdAt: "2026-10-15T16:30:00.000Z",
                prices: [],
                otherEntries: 0,
              },
              draftAuthor: id(5),
              soleOperator: null,
              uncovered: [],
            },
    });
  });
  const commands: string[] = [];
  await page.route("**/merchant/commerce/pricing/command", (route) => {
    commands.push(route.request().postData() ?? "");
    return route.fulfill({
      headers,
      json: {
        status: "Applied",
        priceBookReference: id(10),
        aggregateVersion: 2,
        lifecycle: "Archived",
      },
    });
  });
  await page.goto("/app/commerce/pricing");
  const row = page.getByRole("row", { name: /PRICES-Q19-TEST/u });
  await expect(row).toContainText("Draft, not published yet");
  // Store time (America/Toronto), never UTC.
  await expect(row).toContainText("Oct 15, 2026, 12:30 PM");
  await expect(page.getByText(/UTC/u)).toHaveCount(0);
  // Sole operator is on: the page does not tell the owner to have someone else publish.
  // Owner 2026-10-25: the explanation is under "More about this".
  await page.getByText("More about this").click();
  await expect(page.getByText(/check it and publish it yourself/u)).toBeVisible();
  await expect(page.getByText(/have someone else/u)).toHaveCount(0);
  await expectNoInternalText(page);
  await row.getByRole("link", { name: "Continue draft PRICES-Q19-TEST" }).click();
  await expect(page).toHaveURL(new RegExp("/app/commerce/pricing/" + id(10)));

  // Discarding asks first; keeping the draft sends nothing.
  await page.getByRole("button", { name: "Discard draft" }).click();
  const question = page.getByRole("dialog", { name: "Discard draft PRICES-Q19-TEST?" });
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Keep draft" }).click();
  await expect(question).toBeHidden();
  expect(commands).toHaveLength(0);
  await page.getByRole("button", { name: "Discard draft" }).click();
  await question.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.getByText("Draft discarded.")).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(JSON.parse(commands[0] ?? "{}")).toMatchObject({
    action: "Discard",
    priceBookReference: id(10),
    expectedAggregateVersion: 1,
  });
});

test("@production the allergen list is recorded by one person and approved by another", async ({
  page,
}) => {
  await session(page, [
    {
      screenId: "CMP-ALLERGEN-REVIEW",
      label: "Allergens",
      href: "/app/compliance/allergens",
      permission: "catalog.allergen.read",
    },
  ]);
  let proposal: unknown = null;
  let recordedByYou = true;
  const commands: string[] = [];
  await page.route("**/merchant/compliance/allergens/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CMP-ALLERGEN-REVIEW",
        sourceAsOf: new Date().toISOString(),
        viewer: owner,
        permissions: { mayRead: true, mayDeclare: true, mayManageRegistry: true },
        locale: "en-CA",
        registryProposal: proposal,
        soleOperator:
          proposal !== null && recordedByYou
            ? { status: "NotSet", otherApprovers: [], verifiedUntil: null }
            : null,
        registry: null,
        registryTemplate: {
          template: "CA_PRIORITY_TEST",
          jurisdictionCode: "CA",
          policyDocument: "TEST-ONLY synthetic list.",
          allergens: [{ code: "MILK", name: "Milk" }],
        },
        sources: ["SupplierSpecification"],
        items: [],
      },
    }),
  );
  await page.route("**/merchant/compliance/allergens/command", (route) => {
    const body = route.request().postData() ?? "";
    commands.push(body);
    if (JSON.parse(body).action === "RecordRegistry") {
      proposal = {
        proposalReference: id(30),
        recordedAt: new Date().toISOString(),
        recordedByYou: true,
      };
      return route.fulfill({ headers, json: { status: "Applied", proposalReference: id(30) } });
    }
    return route.fulfill({
      headers,
      json: { status: "Applied", registryVersionReference: id(31) },
    });
  });
  await page.goto("/app/compliance/allergens");
  await page.getByRole("button", { name: "Record this allergen list for approval" }).click();
  await expect(
    page.getByText("You made this change, so someone else who holds allergen list approval"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve the recorded allergen list" }),
  ).toHaveCount(0);
  // Another roster manager sees the recorded list and approves it.
  recordedByYou = false;
  proposal = { ...(proposal as object), recordedByYou: false };
  await page.reload();
  await page.getByRole("button", { name: "Approve the recorded allergen list" }).click();
  await expect(page.getByText("Allergen list approved.")).toBeVisible();
  expect(commands.map((body) => JSON.parse(body))).toEqual([
    expect.objectContaining({ action: "RecordRegistry", template: "CA_PRIORITY_TEST" }),
    expect.objectContaining({ action: "ApproveRegistry", proposalReference: id(30) }),
  ]);
  expect(JSON.parse(commands[1] ?? "{}")).not.toHaveProperty("approvalMode");
});

// WP-2423 v15 staff text: catalog pages show Store time, names and plain words — never ISO/UTC
// times, codes (EACH, KG, DineIn, SYNTHETIC_TAX, OBS_ITEM_30001), step indexes or "Staff 0100".
test("@production v15 catalog pages show staff words: recipe, option recipes, option set, product and tax review", async ({
  page,
}) => {
  await session(page, [
    {
      screenId: "RECIPE-LIST",
      label: "Recipes",
      href: "/app/commerce/recipes",
      permission: "recipe.read",
    },
    {
      screenId: "RECIPE-OPTION-LIST",
      label: "Option recipes",
      href: "/app/commerce/option-recipes",
      permission: "recipe.read",
    },
    {
      screenId: "CAT-OPTIONSET-LIST",
      label: "Options",
      href: "/app/commerce/option-sets",
      permission: "catalog.option_set.read",
    },
    {
      screenId: "CAT-PRODUCT-LIST",
      label: "Products",
      href: "/app/commerce/products",
      permission: "catalog.manage",
    },
    {
      screenId: "TAX-STORE-REVIEW",
      label: "Tax review",
      href: "/app/commerce/tax-review",
      permission: "pricing.tax_config.read",
    },
  ]);
  const at = "2026-10-16T14:05:00.000Z";
  const effective = { status: "Effective", otherApprovers: [], verifiedUntil: null };
  const rules = [
    {
      orderType: "DineIn",
      taxComponentCode: "SYNTHETIC_TAX",
      treatment: "Taxable",
      rate: "0.13",
      priceInclusion: "Exclusive",
    },
    {
      orderType: "Pickup",
      taxComponentCode: "SYNTHETIC_TAX",
      treatment: "Taxable",
      rate: "0.13",
      priceInclusion: "Exclusive",
    },
  ];
  await page.route("**/merchant/commerce/recipes/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "RECIPE-EDITOR",
        sourceAsOf: at,
        permissions: { mayEdit: true, mayReview: true, mayPublish: true },
        viewer: owner,
        soleOperator: effective,
        choices: {
          yieldUnits: ["EACH", "KG"],
          items: [
            {
              itemReference: id(45),
              internalCode: "OBS_ITEM_30001",
              name: "Espresso beans",
              unitCode: "KG",
              latestUnitCostCents: 289,
              allergens: { status: "Declared", contains: [], mayContain: [] },
            },
          ],
          subRecipes: [],
          stations: [{ capabilityReference: id(46), name: "Station 1" }],
          skus: [
            {
              skuReference: id(44),
              code: "FLAT-WHITE-S",
              name: "Flat White — Small",
              unitOfSale: "EACH",
            },
          ],
        },
        recipe: {
          recipeReference: id(40),
          familyReference: id(41),
          familyRevision: 1,
          name: "Flat White",
          code: "FLAT-WHITE",
          lifecycle: "Published",
          versionReference: id(42),
          aggregateVersion: 3,
          yieldQuantity: "1",
          yieldUnit: "EACH",
          ingredientCount: 1,
          standardCostCents: "72",
          kitchenInstructions: "NotPublished",
          bindings: [
            {
              bindingReference: id(43),
              recipeVersionReference: id(42),
              skuReference: id(44),
              storeReference: null,
              since: at,
            },
          ],
          updatedAt: at,
          draft: {
            name: "Flat White",
            code: "FLAT-WHITE",
            yieldQuantity: "1",
            yieldUnit: "EACH",
            ingredients: [
              {
                kind: "InventoryItem",
                sourceReference: id(45),
                quantity: "0.018",
                lossPercent: "0",
                unitCostCents: "0.289",
              },
            ],
            steps: [
              {
                sequence: 0,
                instruction: "Pull a double shot",
                durationSeconds: 30,
                capabilityReference: id(46),
              },
              {
                sequence: 0,
                instruction: "Steam the milk",
                durationSeconds: 60,
                capabilityReference: id(46),
              },
              {
                sequence: 1,
                instruction: "Pour",
                durationSeconds: 30,
                capabilityReference: id(46),
              },
            ],
          },
          ingredientAllergens: [
            {
              line: 1,
              kind: "InventoryItem",
              declared: true,
              current: true,
              contains: [],
              mayContain: [],
            },
          ],
          authorReference: owner,
          authorLabel: "You",
          reviews: [
            {
              reviewReference: id(47),
              subject: "Preparation",
              kind: "Cost",
              decision: "Approved",
              reviewerReference: id(5),
              reviewerLabel: "Noah",
              comment: null,
              reviewedAt: at,
              current: true,
            },
          ],
          family: [{ recipeReference: id(40), revision: 1, lifecycle: "Published" }],
        },
      },
    }),
  );
  await page.goto(`/app/commerce/recipes/${id(40)}/edit`);
  await expect(page.getByRole("heading", { name: "Flat White", level: 2 })).toBeVisible();
  await expect(page.getByText("written by You")).toBeVisible();
  await expect(page.getByText("Step 1: Pull a double shot")).toBeVisible();
  await expect(
    page.getByText(/Step 2: Steam the milk .* \(at the same time as the step before\)/u),
  ).toBeVisible();
  await expect(page.getByText("0.018 kg")).toBeVisible();
  await expect(page.getByText("Approved by Noah on Oct 16, 2026, 10:05 AM")).toBeVisible();
  await expect(page.getByText(/since Oct 16, 2026, 10:05 AM/u)).toBeVisible();
  await expect(page.getByText(/You wrote this version and you are the only person/u)).toBeVisible();
  await expect(page.getByText(/\[0\]|Staff \d{4}/u)).toHaveCount(0);
  await expectNoInternalText(page);

  // The recipe list names its cost column in staff words and shows "$" amounts, never "(CAD)".
  await page.route("**/merchant/commerce/recipes/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "RECIPE-LIST",
        sourceAsOf: at,
        permissions: { mayEdit: true, mayReview: true, mayPublish: true },
        viewer: owner,
        choices: {
          yieldUnits: ["EACH", "KG"],
          items: [],
          subRecipes: [],
          stations: [],
          skus: [
            {
              skuReference: id(44),
              code: "FLAT-WHITE-S",
              name: "Flat White — Small",
              unitOfSale: "EACH",
            },
          ],
        },
        recipes: [
          {
            recipeReference: id(40),
            familyReference: id(41),
            familyRevision: 1,
            name: "Flat White",
            code: "FLAT-WHITE",
            lifecycle: "Published",
            versionReference: id(42),
            aggregateVersion: 3,
            yieldQuantity: "1",
            yieldUnit: "EACH",
            ingredientCount: 1,
            standardCostCents: "72",
            kitchenInstructions: "NotPublished",
            bindings: [
              {
                bindingReference: id(43),
                recipeVersionReference: id(42),
                skuReference: id(44),
                storeReference: null,
                since: at,
              },
            ],
            updatedAt: at,
          },
        ],
      },
    }),
  );
  await page.goto("/app/commerce/recipes");
  await expect(
    page.getByRole("columnheader", { name: "Standard cost", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /Flat White/u })).toContainText("$0.72");
  await expectNoInternalText(page);

  await page.route("**/merchant/commerce/option-recipes/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "RECIPE-OPTION-LIST",
        sourceAsOf: at,
        permissions: { mayEdit: true, mayReview: true, mayPublish: true },
        soleOperator: effective,
        ingredients: [
          {
            itemReference: id(50),
            name: "Oat milk",
            unitCode: "L",
            declared: true,
            latestUnitCostCents: "0.4",
          },
          {
            itemReference: id(51),
            name: "Whole milk",
            unitCode: "L",
            declared: true,
            latestUnitCostCents: "0.3",
          },
        ],
        options: [
          {
            productName: "Flat White",
            setName: "Milk",
            optionName: "Oat milk",
            offered: true,
            bindingReference: id(52),
            optionReference: id(53),
            quantities: [1],
            sizes: [{ skuReference: id(44), name: "Small" }],
            covered: false,
            change: {
              changeVersionReference: id(54),
              version: 1,
              content: {
                kind: "Replace",
                fromItemReference: id(51),
                toItemReference: id(50),
                quantity: null,
                unitCostCents: null,
                lossPercent: "0",
              },
              byViewer: false,
              authorLabel: "Mia",
              recordedAt: at,
              published: false,
              reviews: [
                {
                  kind: "Cost",
                  decision: "Approved",
                  byViewer: true,
                  reviewerLabel: "You",
                  comment: null,
                  reviewedAt: at,
                },
              ],
              lines: [
                {
                  skuReference: id(44),
                  quantity: 1,
                  changes: [
                    {
                      fromItemReference: id(51),
                      fromQuantityMicrounits: "200000",
                      toItemReference: id(50),
                      toQuantityMicrounits: "200000",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    }),
  );
  await page.goto("/app/commerce/option-recipes");
  await expect(page.getByText("Saved by Mia on Oct 16, 2026, 10:05 AM")).toBeVisible();
  await expect(page.getByText("Cost: approved by You on Oct 16, 2026, 10:05 AM")).toBeVisible();
  await expect(page.getByText("Whole milk 0.2 L → Oat milk 0.2 L")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Reviews you cannot give as a second person" }),
  ).toBeVisible();
  await expect(page.getByText("Your own changes")).toHaveCount(0);
  await expect(
    page.getByText(/You already gave the cost review and you are the only person/u),
  ).toBeVisible();
  await expectNoInternalText(page);

  await page.route("**/merchant/commerce/option-sets/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-OPTIONSET-EDIT",
        sourceAsOf: at,
        permissions: { mayEdit: true },
        optionSet: {
          optionSetReference: id(60),
          internalCode: "EXTRA_SHOT",
          aggregateVersion: 1,
          archived: false,
          productNames: [],
          name: "Extra shot",
          kind: "Quantity",
          minimum: 0,
          maximum: 2,
          perOptionMaximum: 2,
          updatedAt: at,
          options: [
            {
              optionReference: id(61),
              code: "EXTRA_SHOT",
              name: "Extra shot",
              offered: true,
              defaultChoice: false,
            },
          ],
        },
      },
    }),
  );
  await page.goto(`/app/commerce/option-sets/${id(60)}`);
  await expect(page.getByText(/Saved, not on any product yet/u)).toBeVisible();
  await expect(page.getByText(/In use/u)).toHaveCount(0);
  await expectNoInternalText(page);

  await page.route("**/merchant/commerce/products/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-PRODUCT-DETAIL",
        sourceAsOf: at,
        locale: "en-CA",
        permissions: {
          mayRead: true,
          mayCreate: true,
          mayEdit: true,
          mayAddSize: true,
          mayStartSelling: true,
        },
        productTypes: ["PreparedFood"],
        sellingUnits: ["EACH"],
        taxClasses: [{ taxClassificationReference: id(70), rules }],
        product: {
          productReference: id(71),
          internalCode: "FLAT_WHITE",
          productType: "PreparedFood",
          lifecycle: "Active",
          aggregateVersion: 4,
          name: "Flat White",
          taxClassificationReference: id(70),
          sizes: [
            {
              skuReference: id(44),
              skuCode: "FLAT_WHITE_S",
              name: "Small",
              lifecycle: "Active",
              unitOfSale: "EACH",
            },
          ],
          optionSets: [],
          createdAt: at,
          updatedAt: at,
        },
        optionSetChoices: [],
      },
    }),
  );
  await page.goto(`/app/commerce/products/${id(71)}/edit`);
  await expect(page.getByText(/updated Oct 16, 2026, 10:05 AM/u)).toBeVisible();
  await expect(page.getByRole("option", { name: /Dine-in 13%/u })).toHaveCount(1);
  await expectNoInternalText(page);

  await page.route("**/merchant/commerce/tax-review/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "TAX-STORE-REVIEW",
        sourceAsOf: at,
        receiptSetup: { taxRegistrationMissing: false, privacyNoticeMissing: false },
        configuration: {
          stableCode: "PILOT_STORE_TAX",
          versionNumber: 1,
          jurisdictionCode: "CA-ON",
          currencyCode: "CAD",
          effectiveFrom: "2026-10-01T04:00:00.000Z",
          effectiveUntil: null,
          registrationEvidenceValidUntil: "2026-10-20T04:00:00.000Z",
          professionalEvidenceValidUntil: "2026-10-20T04:00:00.000Z",
          testOnly: true,
          endsAt: "2026-10-20T04:00:00.000Z",
          endsBecause: "RegistrationEvidence",
          endingSoon: true,
        },
        classes: [{ taxClassificationReference: id(70), rules, productNames: ["Flat White"] }],
        products: [
          {
            productReference: id(71),
            name: "Flat White",
            selling: true,
            taxClassificationReference: id(70),
            status: "Covered",
            missingOrderTypes: [],
          },
        ],
      },
    }),
  );
  await page.goto("/app/commerce/tax-review");
  await expect(page.getByText(/Test configuration \(internal testing only\)/u)).toBeVisible();
  await expect(page.getByText(/Orders can be priced until Oct 20, 2026/u)).toBeVisible();
  await expect(page.getByText(/Dine-in: 13%/u)).toBeVisible();
  await expectNoInternalText(page);
});
