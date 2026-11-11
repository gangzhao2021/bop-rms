import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads, syntheticStoreProfile } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
// Synthetic HTTP interception on the production PWA, not live Store or Catalog evidence.
// WP-2423 (cart-unsellable-dishes, v15 fabf0261): staff unticked "Offer Hot" on Soy milk's
// "Serve" group, where Hot is the choice guests start with. The guest's page greys Hot, starts
// with nothing chosen, and Iced adds. An add refused because a choice went off meanwhile names it
// after reading the menu again, and the page never says the connection dropped.
const id = (n: number) => "018f8903-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hot = id(31),
  iced = id(32);

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet", width: 1024, height: 768, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Option not offered " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    for (const scenario of [
      "hot off",
      "refused meanwhile",
      "all off",
      // WP-2423 (M22, M24, M154): Hot sold out at the Store today; the dish sold out meanwhile.
      "hot sold out",
      "dish sold out meanwhile",
      // WP-2423 (M166, M178): Iced adds milk of its own; the kitchen's statement above the menu.
      "iced adds milk",
    ] as const)
      test(scenario, async ({ page }) => {
        const failures: string[] = [];
        page.on("pageerror", () => failures.push("page error"));
        const at = new Date().toISOString(),
          expiresAt = new Date(Date.now() + 600_000).toISOString();
        // "refused meanwhile": the page was read while Hot was offered; it goes off before Add.
        let hotOff =
          scenario !== "refused meanwhile" &&
          scenario !== "dish sold out meanwhile" &&
          scenario !== "iced adds milk";
        if (scenario === "iced adds milk")
          await page.route("**/api/v1/customer/store", (route) =>
            route.fulfill({
              status: 200,
              headers: { "cache-control": "private, max-age=30" },
              contentType: "application/json",
              body: JSON.stringify({
                ...syntheticStoreProfile,
                store: {
                  kitchenStatement: {
                    handled: [
                      { code: "PEANUT", name: "peanuts" },
                      { code: "SESAME", name: "sesame" },
                    ],
                    sharedEquipment: ["Woks", "FryerOil"],
                  },
                  ...syntheticStoreProfile.store,
                },
              }),
            }),
          );
        let menuReads = 0;
        await page.route("**/bff/customer/entry", (route) =>
          route.fulfill({
            status: 201,
            headers: { "cache-control": "no-store" },
            json: {
              schemaVersion: 2,
              status: "Established",
              brandDisplayName: "Synthetic Brand",
              storeDisplayName: "Synthetic Soy Store",
              publicStoreReference: id(4),
              publicTableReference: null,
              channel: "Pickup",
              operatingState: "Open",
              availableServiceModes: ["Pickup"],
              locale: "en-CA",
              contextExpiresAt: expiresAt,
              csrfToken: "s".repeat(43),
            },
          }),
        );
        const option = (reference: string, name: string, start: boolean, off: boolean) => ({
          optionReference: reference,
          name,
          maximumQuantity: 1,
          conflictOptionReferences: [],
          selectedByDefault: start,
          defaultQuantity: start ? 1 : 0,
          ...(off ? { offeredNow: false } : {}),
          ...(off && reference === hot && scenario === "hot sold out" ? { soldOut: true } : {}),
          incrementalPrice: { status: "Available", amount: "0.00", currency: "CAD", reason: null },
        });
        await page.route("**/api/v1/public/stores/*/menu?*", (route) => {
          menuReads += 1;
          return route.fulfill({
            status: 200,
            json: {
              status: "Found",
              schemaVersion: 1,
              projection: {
                name: "catalog_published_menu_v1",
                version: 1,
                asOfUtc: at,
                sourceCheckpoint: id(5),
                sourceAggregateVersion: 1,
                freshnessStatus: "Fresh",
                freshnessTargetMilliseconds: 5000,
                stale: false,
                partial: true,
              },
              scope: {
                publicStoreReference: id(4),
                channelCode: "CUSTOMER_PWA",
                orderTypeCode: "PICKUP",
                effectiveAt: at,
              },
              menu: {
                menuReference: id(6),
                menuVersionReference: id(7),
                releaseReference: id(8),
                locale: "en-CA",
                name: "Synthetic menu",
                effectiveFrom: at,
                effectiveUntil: null,
                sections: [
                  {
                    sectionReference: id(9),
                    name: "Drinks",
                    sellables: [
                      {
                        sellableReference: id(3),
                        productVersionReference: id(10),
                        name: "Synthetic soy milk",
                        description: null,
                        photo: null,
                        presentationRole: "Standard",
                        pinned: false,
                        availability: "Available",
                        optionRules: [
                          {
                            semanticsVersion: 2,
                            activationOptionReferences: [],
                            name: "Serve",
                            bindingReference: id(35),
                            optionSetVersionReference: id(34),
                            minimumSelections: 1,
                            maximumSelections: 1,
                            enabledOptionReferences: [hot, iced],
                            defaultOptionReferences: [hot],
                            options: [
                              option(hot, "Hot", true, hotOff),
                              option(iced, "Iced", false, scenario === "all off"),
                            ],
                          },
                        ],
                        allergenDisclosure:
                          scenario === "iced adds milk"
                            ? {
                                registryVersionReference: id(11),
                                items: [
                                  {
                                    allergenReference: id(12),
                                    code: "MILK",
                                    name: "Milk",
                                    classification: "Contains",
                                  },
                                ],
                                allergenFreeClaim: false,
                                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                                byOption: {
                                  [iced]: [{ code: "MILK", classification: "Contains" }],
                                },
                              }
                            : {
                                registryVersionReference: id(11),
                                items: [],
                                allergenFreeClaim: false,
                                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                              },
                        displayPrice: {
                          status: "Available",
                          amount: "3.50",
                          currency: "CAD",
                          reason: null,
                        },
                        taxDisplayContext: {
                          status: "Unavailable",
                          taxInclusive: null,
                          reason: "FINAL_QUOTE_REQUIRED",
                        },
                      },
                    ],
                  },
                ],
              },
            },
          });
        });
        const cart = (items: unknown[]) => ({
          schemaVersion: 1,
          cart: {
            cartReference: id(1),
            version: items.length + 1,
            orderType: "Pickup",
            serviceMode: "Pickup",
            context: { brandName: "Synthetic Brand", storeName: "Synthetic Soy Store" },
            lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
            items,
            quote: null,
            warnings: [],
          },
        });
        await page.route("**/bff/customer/cart", (route) =>
          route.fulfill({ status: 200, headers: { "cache-control": "no-store" }, json: cart([]) }),
        );
        const adds: unknown[] = [];
        await page.route("**/api/v1/carts/*/items", async (route) => {
          const body = route.request().postDataJSON() as {
            optionSelections: { optionReference: string }[];
          };
          adds.push(body.optionSelections.map((selection) => selection.optionReference));
          if (scenario === "dish sold out meanwhile") {
            await route.fulfill({
              status: 422,
              json: {
                schemaVersion: 1,
                error: {
                  code: "cart_selection_invalid",
                  messageKey: "customer.cart.selection_invalid",
                  issueCodes: ["CATALOG_ITEM_SOLD_OUT"],
                },
              },
            });
            return;
          }
          if (body.optionSelections.some((selection) => selection.optionReference === hot)) {
            // Staff unticked Hot after this page was read.
            hotOff = true;
            await route.fulfill({
              status: 422,
              json: {
                schemaVersion: 1,
                error: {
                  code: "cart_selection_invalid",
                  messageKey: "customer.cart.selection_invalid",
                  issueCodes: ["CATALOG_OPTION_NOT_OFFERED"],
                },
              },
            });
            return;
          }
          await route.fulfill({
            status: 200,
            headers: { "cache-control": "no-store" },
            json: cart([
              {
                cartItemReference: id(2),
                sellableReference: id(3),
                displayName: "Synthetic soy milk",
                quantity: 1,
                configuration: [],
                customerNote: null,
                lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
                warnings: [],
              },
            ]),
          });
        });
        const press = async (locator: ReturnType<typeof page.getByRole>) => {
          if (screen.touch) await locator.tap();
          else await locator.click();
        };
        await page.goto("/#qr=aaa.bbb.ccc");
        await expect(
          page.getByRole("heading", { name: "Synthetic Soy Store", exact: true }),
        ).toBeVisible();
        await press(page.getByRole("button", { name: "Continue to menu", exact: true }));
        if (scenario === "iced adds milk")
          await expect(
            page.getByText(
              "Our kitchen uses peanuts, sesame, and shares woks, fryer oil. Any dish may contain traces.",
              { exact: true },
            ),
          ).toBeVisible();
        await press(page.getByRole("link", { name: "View Synthetic soy milk", exact: true }));
        const hotChoice = page.getByRole("radio", { name: "Hot", exact: true });
        const icedChoice = page.getByRole("radio", { name: "Iced", exact: true });
        const add = page.getByRole("button", { name: "Add to cart", exact: true });
        if (scenario === "iced adds milk") {
          // Iced says what it adds; Hot adds nothing and says nothing.
          await expect(page.getByText("Adds: Milk", { exact: true })).toBeVisible();
          await expect(page.getByText(/^Adds:/u)).toHaveCount(1);
          await page.screenshot({
            path: `test-results/choice-adds-${screen.width}.png`,
            fullPage: true,
          });
        } else if (scenario === "all off") {
          await expect(
            page.getByText("Synthetic soy milk isn't available right now.", { exact: true }),
          ).toBeVisible();
          await expect(hotChoice).toBeDisabled();
          await expect(icedChoice).toBeDisabled();
          await expect(add).toBeDisabled();
        } else if (scenario === "hot sold out") {
          await expect(hotChoice).toBeDisabled();
          await expect(hotChoice).not.toBeChecked();
          await expect(page.getByText("Sold out today", { exact: true })).toBeVisible();
          await expect(page.getByText("Only Iced is left today", { exact: true })).toBeVisible();
          await expect(page.getByText("Not available now", { exact: true })).toHaveCount(0);
          await page.screenshot({
            path: `test-results/option-sold-out-${screen.width}.png`,
            fullPage: true,
          });
          await press(icedChoice);
          await press(add);
          await expect(page).toHaveURL(/\/menu$/u);
          expect(adds).toEqual([[iced]]);
        } else if (scenario === "dish sold out meanwhile") {
          await expect(hotChoice).toBeChecked();
          await press(add);
          // The real reason is the headline, with the way back to the menu.
          await expect(page.getByText("This dish just sold out.", { exact: true })).toBeVisible();
          await expect(page.getByText(/can’t be ordered as selected/u)).toHaveCount(0);
          await expect(
            page.getByRole("alert").getByRole("link", { name: "Back to menu" }),
          ).toBeVisible();
          await page.screenshot({
            path: `test-results/dish-sold-out-meanwhile-${screen.width}.png`,
            fullPage: true,
          });
          await press(page.getByRole("alert").getByRole("link", { name: "Back to menu" }));
          await expect(page).toHaveURL(/\/menu$/u);
        } else if (scenario === "hot off") {
          await expect(hotChoice).toBeDisabled();
          await expect(hotChoice).not.toBeChecked();
          await expect(icedChoice).not.toBeChecked();
          await expect(page.getByText("Not available now", { exact: true })).toBeVisible();
          await press(icedChoice);
          await press(add);
          await expect(page).toHaveURL(/\/menu$/u);
          expect(adds).toEqual([[iced]]);
        } else {
          await expect(hotChoice).toBeChecked();
          const readsBeforeAdd = menuReads;
          await press(add);
          // The menu is read again in place: Hot is greyed and named, the guest chooses Iced.
          await expect(
            page.getByText("Hot isn't available right now. Please choose another.", {
              exact: true,
            }),
          ).toBeVisible();
          await expect(page.getByText("Not available now", { exact: true })).toBeVisible();
          await expect(add).toBeDisabled();
          // Read again once only: the guest's phone does not keep fetching the menu.
          await page.waitForTimeout(1_500);
          expect(menuReads).toBe(readsBeforeAdd + 1);
          await press(icedChoice);
          // Once the guest moves off it, the choice that is off can't be chosen again.
          await expect(hotChoice).toBeDisabled();
          await expect(add).toBeEnabled();
          await press(add);
          await expect(page).toHaveURL(/\/menu$/u);
          expect(adds).toEqual([[hot], [iced]]);
        }
        await expect(page.getByText(/connection dropped/u)).toHaveCount(0);
        await expectNoInternalText(page);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        expect(failures).toEqual([]);
      });
  });
}
