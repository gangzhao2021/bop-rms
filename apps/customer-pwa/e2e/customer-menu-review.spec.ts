import { expect, test } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));

test("CUST-MENU follows the Figma Review hierarchy at 1440, 390, and 320px @demo", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("pageerror", (error) => violations.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") violations.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByRole("status", { name: "Local synthetic preview" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Preview routes" })
    .getByRole("link", {
      name: "Menu",
      exact: true,
    })
    .click();

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const main = page.getByRole("main");
    const menuHeading = main.getByRole("heading", { name: "Menu", exact: true });
    await expect(menuHeading).toBeVisible();
    if (viewport.width === 1440) {
      await expect(menuHeading).toBeFocused();
      await menuHeading.evaluate((element) => (element as HTMLElement).blur());
    }
    await expect(
      main.getByRole("heading", { name: "Training favourites", exact: true }),
    ).toBeVisible();
    await expect(
      main.getByRole("link", { name: "View Synthetic mushroom rice bowl" }),
    ).toBeVisible();
    await expect(main.getByText("Priced at checkout", { exact: true }).first()).toBeVisible();
    await expect(
      main.getByText("Contains Soy · May contain Sesame", { exact: true }),
    ).toBeVisible();
    await expect(main).not.toContainText("$0");
    await expect(
      page.getByRole("navigation", { name: "Customer journey" }).getByText("Menu", { exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `test-results/customer-menu-${viewport.width}.png`,
      fullPage: true,
    });
  }

  expect(violations).toEqual([]);
});

// WP-2423 item 11: a free choice has no price text, on screen or aloud; a paid one and a combo dish's
// allergens are read with their control. Item 12: a dish's line says what it declares itself.
const menuStore = "018f7610-0000-7000-8000-000000000001";
const ref = (n: number) => `018f7610-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function choiceMenu() {
  const at = "2026-10-17T12:00:00.000Z";
  const option = (n: number, name: string, amount: string | null) => ({
    optionReference: ref(n),
    name,
    maximumQuantity: 1,
    conflictOptionReferences: [],
    selectedByDefault: false,
    incrementalPrice:
      amount === null
        ? { status: "Unavailable", amount: null, currency: null, reason: "PRICE_NOT_SET" }
        : { status: "Available", amount, currency: "CAD", reason: null },
  });
  const rule = (n: number, name: string, options: ReturnType<typeof option>[], combo = false) => ({
    name,
    bindingReference: ref(n),
    optionSetVersionReference: ref(n + 1),
    minimumSelections: 1,
    maximumSelections: 1,
    enabledOptionReferences: options.map((entry) => entry.optionReference),
    defaultOptionReferences: [],
    ...(combo ? { comboPart: true } : {}),
    options,
  });
  const milk = {
    allergenReference: ref(60),
    code: "MILK",
    name: "Milk",
    classification: "Contains",
  };
  const sellable = (
    n: number,
    name: string,
    optionRules: unknown[],
    disclosure: Record<string, unknown> = {},
  ) => ({
    sellableReference: ref(n),
    productVersionReference: ref(n + 1),
    name,
    description: null,
    photo: null,
    presentationRole: "Standard",
    pinned: false,
    availability: "Available",
    optionRules,
    allergenDisclosure: {
      registryVersionReference: ref(61),
      items: [milk],
      allergenFreeClaim: false,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
      ...disclosure,
    },
    displayPrice: { status: "Available", amount: "6.50", currency: "CAD", reason: null },
    taxDisplayContext: {
      status: "Unavailable",
      taxInclusive: null,
      reason: "FINAL_QUOTE_REQUIRED",
    },
  });
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: at,
      sourceCheckpoint: ref(2),
      sourceAggregateVersion: 1,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: menuStore,
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "DINE_IN",
      effectiveAt: at,
    },
    menu: {
      menuReference: ref(3),
      menuVersionReference: ref(4),
      releaseReference: ref(5),
      locale: "en-CA",
      name: "Synthetic menu",
      effectiveFrom: at,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: ref(6),
          name: "Drinks",
          sellables: [
            sellable(10, "Synthetic milk tea", [
              rule(12, "Milk", [
                option(14, "Whole milk", "0.00"),
                option(15, "Oat beverage", "0.75"),
                option(16, "Soy beverage", null),
              ]),
            ]),
            sellable(
              20,
              "Synthetic combo",
              [
                rule(
                  22,
                  "Dessert",
                  [option(24, "Red bean soup", "0.00"), option(25, "Egg waffle", "1.50")],
                  true,
                ),
              ],
              // The dish beside the waffle declares nothing; the waffle declares milk.
              {
                byOption: {
                  [ref(24)]: [],
                  [ref(25)]: [{ code: "MILK", classification: "Contains" }],
                },
              },
            ),
          ],
        },
      ],
    },
  };
}
test.describe("@production choices on the item page", () => {
  test.use({ serviceWorkers: "block", viewport: { width: 320, height: 800 } });
  test.beforeEach(async ({ page }) => {
    await page.context().route("**/api/v1/customer/session/csrf", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({
          schemaVersion: 1,
          csrfToken: "a".repeat(43),
          menuContext: {
            publicStoreReference: menuStore,
            channel: "DineIn",
            locale: "en-CA",
            brandDisplayName: "Synthetic brand",
            storeDisplayName: "Synthetic Store",
          },
        }),
      }),
    );
    await page.context().route(`**/api/v1/public/stores/${menuStore}/menu**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(choiceMenu()),
      }),
    );
  });
  const noOverflow = (page: import("@playwright/test").Page) =>
    expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);

  test("a free choice reads its name only; a paid one is announced with its price", async ({
    page,
  }) => {
    await page.goto(`/menu/items/${ref(10)}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("radio", { name: "Oat beverage" })).toHaveAccessibleDescription(
      "+ $0.75",
    );
    await expect(main.getByRole("radio", { name: "Soy beverage" })).toHaveAccessibleDescription(
      "Priced at checkout",
    );
    await expect(main.getByRole("radio", { name: "Whole milk" })).toHaveAccessibleDescription("");
    await expect(main).not.toContainText("Included");
    await expect(main).not.toContainText("$0.00");
    await noOverflow(page);
  });

  test("a combo dish is read with what it declares, with its price when it has one", async ({
    page,
  }) => {
    await page.goto(`/menu/items/${ref(20)}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("radio", { name: "Red bean soup" })).toHaveAccessibleDescription(
      "No allergens listed",
    );
    await expect(main.getByRole("radio", { name: "Egg waffle" })).toHaveAccessibleDescription(
      "+ $1.50 Contains Milk",
    );
    await noOverflow(page);
  });
});
