import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 DEC-DINING-GUEST-TABLE-START: where the Store turned it on, a guest scanning a free table
// starts it with one tap, or with their first dish. A scan alone starts nothing. Synthetic HTTP
// standing in for the API; the server's rules are proven by the database acceptance test
// (dining-guest-table-start).
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const noStore = { "cache-control": "no-store" };

const offer = (code: string, messageKey: string, action: string) => ({
  status: 409,
  headers: noStore,
  json: {
    schemaVersion: 1,
    code,
    messageKey,
    recovery: { action, storeSelection: "Hidden" },
    store: {
      brandDisplayName: "Synthetic Brand",
      storeDisplayName: "Synthetic Tea House",
      publicStoreReference: id(4),
      locale: "en-CA",
    },
  },
});
const established = () => ({
  status: 201,
  headers: noStore,
  json: {
    schemaVersion: 2,
    status: "Established",
    brandDisplayName: "Synthetic Brand",
    storeDisplayName: "Synthetic Tea House",
    publicStoreReference: id(4),
    publicTableReference: id(5),
    channel: "DineIn",
    operatingState: "Open",
    availableServiceModes: ["DineIn"],
    locale: "en-CA",
    contextExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    tableOpen: false,
    csrfToken: "g".repeat(43),
  },
});

async function menu(page: Page) {
  const at = new Date().toISOString();
  await page.route("**/api/v1/public/stores/*/menu?*", (route) => {
    return route.fulfill({
      status: 200,
      json: {
        status: "Found",
        schemaVersion: 1,
        projection: {
          name: "catalog_published_menu_v1",
          version: 1,
          asOfUtc: at,
          sourceCheckpoint: id(6),
          sourceAggregateVersion: 1,
          freshnessStatus: "Fresh",
          freshnessTargetMilliseconds: 5000,
          stale: false,
          partial: true,
        },
        scope: {
          publicStoreReference: id(4),
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "DINE_IN",
          effectiveAt: at,
        },
        menu: {
          menuReference: id(7),
          menuVersionReference: id(8),
          releaseReference: id(9),
          locale: "en-CA",
          name: "Synthetic menu",
          effectiveFrom: at,
          effectiveUntil: null,
          sections: [
            {
              sectionReference: id(10),
              name: "Drinks",
              sellables: [
                {
                  sellableReference: id(3),
                  productVersionReference: id(11),
                  name: "Synthetic tea",
                  description: null,
                  photo: null,
                  presentationRole: "Standard",
                  pinned: false,
                  availability: "Available",
                  optionRules: [],
                  allergenDisclosure: {
                    registryVersionReference: id(12),
                    items: [],
                    allergenFreeClaim: false,
                    assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                  },
                  displayPrice: {
                    status: "Available",
                    amount: "4.50",
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
}

/** The join and its binding, recording what the phone said. */
async function joining(page: Page, bodies: string[]) {
  const expiresAt = new Date(Date.now() + 900_000).toISOString();
  await page.route("**/bff/customer/dining/qr-join", (route: Route) => {
    bodies.push(route.request().postData() ?? "");
    return route.fulfill({
      status: 200,
      headers: noStore,
      json: {
        status: "Joined",
        operationReference: route.request().headers()["idempotency-key"],
        admissionReference: id(30),
      },
    });
  });
  await page.route("**/bff/customer/dining-binding/prepare", (route) =>
    route.fulfill({
      status: 200,
      headers: noStore,
      json: {
        status: "Prepared",
        operationReference: route.request().headers()["idempotency-key"],
        candidateCsrfToken: "n".repeat(43),
        recoveryProof: "r".repeat(43),
        expiresAt,
      },
    }),
  );
  await page.route("**/bff/customer/dining-binding/activate", (route) =>
    route.fulfill({
      status: 200,
      headers: noStore,
      json: {
        status: "Activated",
        operationReference: route.request().headers()["idempotency-key"],
        csrfToken: "n".repeat(43),
      },
    }),
  );
}

test.describe("@production CUST-ENTRY guest starts a free table", () => {
  test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });

  test("a scan starts nothing; the guest's tap starts the table and opens the menu", async ({
    page,
  }) => {
    const entries: unknown[] = [];
    await page.route("**/bff/customer/entry", (route) => {
      const body = route.request().postDataJSON() as { intent?: string };
      entries.push(body.intent ?? null);
      return route.fulfill(
        body.intent === "Start"
          ? established()
          : offer("entry_table_may_start", "customer.entry.table_may_start", "StartTable"),
      );
    });
    const joins: string[] = [];
    await joining(page, joins);
    await menu(page);
    await page.goto("/#qr=aaa.bbb.ccc");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Order at this table" })).toBeVisible();
    await expect(main).toContainText(
      "You pay on your phone each time you order. No account needed.",
    );
    await expect(main).not.toContainText("Nobody is at this table");
    await expect(main.getByRole("button", { name: "Join this table" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "I have a join code" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Look at the menu first" })).toBeVisible();
    expect(entries).toEqual([null]);
    expect(joins).toEqual([]);
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/customer-table-start-390.png", fullPage: true });

    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(main.getByRole("heading", { name: "在这张桌点餐" })).toBeVisible();
    await expect(main).toContainText("每次点餐在手机上付款，不用注册。");
    await expect(main.getByRole("button", { name: "开始点餐" })).toBeVisible();
    await expect(main.getByRole("button", { name: "先看看菜单" })).toBeVisible();
    await page.screenshot({ path: "test-results/customer-table-start-zh-390.png", fullPage: true });
    await page.getByRole("button", { name: "English" }).click();

    await main.getByRole("button", { name: "Start ordering" }).click();
    await expect(page).toHaveURL(/\/menu/u);
    expect(entries).toEqual([null, "Start"]);
    expect(joins).toEqual(["{}"]);
  });

  test("adding a dish from the menu first starts the table and keeps the dish, with no prompt", async ({
    page,
  }) => {
    const entries: unknown[] = [];
    await page.route("**/bff/customer/entry", (route) => {
      const body = route.request().postDataJSON() as { intent?: string };
      entries.push(body.intent ?? null);
      return route.fulfill(
        body.intent === "Start"
          ? established()
          : offer("entry_table_may_start", "customer.entry.table_may_start", "StartTable"),
      );
    });
    const joins: string[] = [];
    await joining(page, joins);
    await menu(page);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const line = (quantity: number) => ({
      cartItemReference: id(40),
      sellableReference: id(3),
      displayName: "Synthetic tea",
      quantity,
      configuration: [],
      customerNote: null,
      lineEstimate: { status: "Unavailable", reasonCode: "FINAL_QUOTE_REQUIRED" },
      warnings: [],
    });
    const cart = (items: unknown[]) => ({
      status: 200,
      headers: noStore,
      json: {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: items.length + 1,
          orderType: "DineIn",
          serviceMode: "DineIn",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Tea House" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items,
          quote: null,
          warnings: [],
        },
      },
    });
    const added: { quantity: number }[] = [];
    await page.route("**/bff/customer/cart", (route) =>
      route.request().method() === "GET" && added.length === 0
        ? route.fulfill({
            status: 404,
            headers: noStore,
            json: { error: { code: "cart_not_found" } },
          })
        : route.fulfill(cart(added.map((item) => line(item.quantity)))),
    );
    await page.route("**/api/v1/carts**", (route) => {
      const url = route.request().url();
      if (route.request().method() !== "POST") return route.fulfill(cart([]));
      if (url.includes("/items"))
        added.push(route.request().postDataJSON() as { quantity: number });
      return route.fulfill({ ...cart(added.map((item) => line(item.quantity))), status: 201 });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "Look at the menu first" }).click();
    expect(entries).toEqual([null]);
    await page.getByRole("link", { name: "View Synthetic tea", exact: true }).click();
    // The guest's own choice, made before anything was started.
    await page.getByRole("button", { name: "Increase quantity" }).click();
    await page.getByRole("button", { name: "Increase quantity" }).click();
    await expect(page.locator("#configure-quantity")).toHaveValue("3");
    await page.getByRole("button", { name: "Add to cart", exact: true }).click();
    await expect.poll(() => entries).toEqual([null, "Start"]);
    await expect.poll(() => joins).toEqual(["{}"]);
    // The dish they chose goes in as chosen.
    await expect.poll(() => added).toEqual([expect.objectContaining({ quantity: 3 })]);
    await expect(page.getByRole("status").getByText("Added to your cart.")).toBeVisible();
    await expect(page.getByText("You can order once staff seat you")).toHaveCount(0);
    await expect(page.getByText("Scan the location QR code again")).toHaveCount(0);
    await expectNoInternalText(page);
  });

  test("asked whether they're with the people here, a dish from the menu waits for that answer", async ({
    page,
  }) => {
    await page.route("**/bff/customer/entry", (route) =>
      route.fulfill(
        offer("entry_table_ask_new_party", "customer.entry.table_ask_new_party", "AnswerNewParty"),
      ),
    );
    await menu(page);
    await page.goto("/#qr=aaa.bbb.ccc");
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "Are you with the people already at this table?" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Menu", exact: true }).first().click();
    await page.getByRole("link", { name: "View Synthetic tea", exact: true }).click();
    await page.getByRole("button", { name: "Add to cart", exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("First tell us if you’re with the people at this table.");
    await expect(page.getByText("once staff seat you")).toHaveCount(0);
    await expectNoInternalText(page);
    await alert.getByRole("link", { name: "Back to the question" }).click();
    await expect(
      main.getByRole("heading", { name: "Are you with the people already at this table?" }),
    ).toBeVisible();
    await expect(main.getByRole("button", { name: "No, we just sat down" })).toBeVisible();
  });

  test("a start that can't be given just now says so, and the guest can try again", async ({
    page,
  }) => {
    await page.route("**/bff/customer/entry", (route) => {
      const body = route.request().postDataJSON() as { intent?: string };
      return route.fulfill(
        body.intent === "Start"
          ? established()
          : offer("entry_table_may_start", "customer.entry.table_may_start", "StartTable"),
      );
    });
    const joins: string[] = [];
    await page.route("**/bff/customer/dining/qr-join", (route) => {
      joins.push(route.request().postData() ?? "");
      return route.fulfill({
        status: 429,
        headers: noStore,
        json: {
          error: { code: "dining_join_table_busy", messageKey: "customer.dining.join_table_busy" },
        },
      });
    });
    await menu(page);
    await page.goto("/#qr=aaa.bbb.ccc");
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "Start ordering" }).click();
    await expect(main.getByRole("alert")).toContainText(
      "This table can’t be started just now. Pick another table or ask staff.",
    );
    // Nobody is at this table: no people to join, and no code to ask anyone for.
    await expect(main).not.toContainText("Many phones joined");
    await expect(main.getByRole("button", { name: "Join this table" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "I have a join code" })).toHaveCount(0);
    await expectNoInternalText(page);
    await main.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => joins.length).toBe(2);
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(main.getByRole("alert")).toContainText("这张桌暂时不能开始。请换一张桌或找店员。");
    await expect(main.getByRole("button", { name: "重试" })).toBeVisible();
  });

  test("a friend who also said they just sat down is offered the table their friend started", async ({
    page,
  }) => {
    await page.route("**/bff/customer/entry", (route) => {
      const body = route.request().postDataJSON() as { intent?: string };
      return route.fulfill(
        body.intent === undefined
          ? offer(
              "entry_table_ask_new_party",
              "customer.entry.table_ask_new_party",
              "AnswerNewParty",
            )
          : established(),
      );
    });
    const joins: string[] = [];
    await joining(page, joins);
    // The first answer comes too late: their friend's phone started the table a moment before.
    await page.route("**/bff/customer/dining/qr-join", (route) =>
      joins.length > 0
        ? route.fallback()
        : (joins.push(route.request().postData() ?? ""),
          route.fulfill({
            status: 409,
            headers: noStore,
            json: {
              error: {
                code: "dining_join_table_in_use",
                messageKey: "customer.dining.join_table_in_use",
              },
            },
          })),
    );
    await menu(page);
    await page.goto("/#qr=aaa.bbb.ccc");
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "No, we just sat down" }).click();
    await expect(main.getByRole("alert")).toContainText(
      "People are using this table. If you’re together, join them, or ask staff.",
    );
    await expect(main).not.toContainText("just ordered");
    await expectNoInternalText(page);
    // Joining them doesn't repeat "we just sat down".
    await main.getByRole("button", { name: "Join this table" }).click();
    await expect(page).toHaveURL(/\/menu/u);
    expect(joins).toEqual([JSON.stringify({ newParty: true }), "{}"]);
  });

  test("looking at the menu first, Your table says how to start, not to find a code", async ({
    page,
  }) => {
    await page.route("**/bff/customer/entry", (route) =>
      route.fulfill(offer("entry_table_may_start", "customer.entry.table_may_start", "StartTable")),
    );
    await menu(page);
    await page.goto("/#qr=aaa.bbb.ccc");
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "Look at the menu first" }).click();
    await page.getByRole("link", { name: "Your table" }).first().click();
    await expect(main.getByRole("heading", { name: "Start this table first" })).toBeVisible();
    await expect(main).toContainText(
      "Add a dish from the menu to start, or go back to start this table.",
    );
    await expect(main).not.toContainText("join code");
    await expectNoInternalText(page);
  });

  test("a table being cleaned says so and keeps the menu; no visit starts", async ({ page }) => {
    await page.route("**/bff/customer/entry", (route) =>
      route.fulfill(
        offer("entry_table_being_cleaned", "customer.entry.table_being_cleaned", "AskStaff"),
      ),
    );
    await menu(page);
    await page.goto("/#qr=aaa.bbb.ccc");
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", {
        name: "This table is being cleaned. Pick another table or ask staff.",
      }),
    ).toBeVisible();
    await expect(main.getByRole("button", { name: "Start ordering" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Look at the menu first" })).toBeVisible();
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(
      main.getByRole("heading", { name: "这张桌正在清理，请换一张桌或找店员。" }),
    ).toBeVisible();
    await expectNoInternalText(page);
  });

  test("the next party is asked once; each answer does what it says", async ({ page }) => {
    const entries: unknown[] = [];
    await page.route("**/bff/customer/entry", (route) => {
      const body = route.request().postDataJSON() as { intent?: string };
      entries.push(body.intent ?? null);
      return route.fulfill(
        body.intent === undefined
          ? offer(
              "entry_table_ask_new_party",
              "customer.entry.table_ask_new_party",
              "AnswerNewParty",
            )
          : established(),
      );
    });
    const joins: string[] = [];
    await joining(page, joins);
    await menu(page);
    await page.goto("/#qr=aaa.bbb.ccc");
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "Are you with the people already at this table?" }),
    ).toBeVisible();
    await expect(main.getByRole("button", { name: "Yes, join them" })).toBeVisible();
    await page.screenshot({
      path: "test-results/customer-table-new-party-390.png",
      fullPage: true,
    });
    await main.getByRole("button", { name: "No, we just sat down" }).click();
    await expect(page).toHaveURL(/\/menu/u);
    expect(entries).toEqual([null, "NewParty"]);
    expect(joins).toEqual([JSON.stringify({ newParty: true })]);
    await expectNoInternalText(page);
  });

  for (const [screen, code, messageKey, action, words, button] of [
    [
      "starting",
      "entry_table_may_start",
      "customer.entry.table_may_start",
      "StartTable",
      "After you start, this receipt won’t open on this phone.",
      "Start ordering",
    ],
    [
      "answering the next party's question",
      "entry_table_ask_new_party",
      "customer.entry.table_ask_new_party",
      "AnswerNewParty",
      "After you answer, this receipt won’t open on this phone.",
      "No, we just sat down",
    ],
  ] as const)
    test(`a guest whose visit ended sees the receipt first, and is told ${screen} ends it on this phone`, async ({
      page,
    }) => {
      await page.route("**/api/v1/customer/session/csrf", (route) =>
        route.fulfill({
          status: 200,
          headers: noStore,
          json: {
            schemaVersion: 1,
            settledTable: { tableLabel: "12", csrfToken: "e".repeat(43) },
          },
        }),
      );
      await page.route("**/api/v1/dine-in/table-payment", (route) =>
        route.fulfill({ status: 404, headers: noStore, json: { error: { code: "not_found" } } }),
      );
      await page.route("**/bff/customer/entry", (route) =>
        route.fulfill(offer(code, messageKey, action)),
      );
      await menu(page);
      await page.goto("/#qr=aaa.bbb.ccc");
      const main = page.getByRole("main");
      await expect(
        main.getByRole("heading", { name: "This table is settled. Thank you for dining with us." }),
      ).toBeVisible();
      await expect(main).toContainText(words);
      await expect(main.getByRole("button", { name: button })).toBeVisible();
      await expectNoInternalText(page);
    });
});
