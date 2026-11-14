import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 price-hold-dish-changes (v15 batch 6, DEC-PRICE-HOLD §2 and §3). What a guest sees when the
// restaurant changes a dish already in the cart:
// - a price listed higher while the cart is open: after a reload the cart names the dish with its
//   old and new price and asks the guest to tick before Place order (never "up to date");
// - a dish renamed or given another allergen: checkout names it, shows its allergens now, and the
//   guest ticks before paying;
// - a dish sold out at checkout: one way back to the cart, not two identical links.
// Synthetic HTTP interception on the production PWA; the restricted-role database acceptance
// (price-hold-dish-changes) proves the server refuses the held price for a changed dish.
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => "018f8a20-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);

/** The dish as the restaurant lists it now; the test changes it between page loads. */
interface Dish {
  name: string;
  priceDollars: string;
  /** Allergen names the dish may contain. */
  mayContain: string[];
  /**
   * v15 2026-11-11 b10: the dish's Chinese name. When set, the Store says which language's name
   * changed (as v15 does); without it the stub answers as an older server.
   */
  nameZh?: string;
}

function menu(dish: Dish) {
  const at = new Date().toISOString();
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: at,
      sourceCheckpoint: id(40),
      sourceAggregateVersion: 1,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: publicStore,
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "DINE_IN",
      effectiveAt: at,
    },
    menu: {
      menuReference: id(41),
      menuVersionReference: id(42),
      releaseReference: id(43),
      locale: "en-CA",
      name: "Synthetic menu",
      effectiveFrom: at,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(44),
          name: "Noodles",
          sellables: [
            {
              sellableReference: id(3),
              productVersionReference: id(45),
              name: dish.name,
              description: null,
              photo: null,
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {
                registryVersionReference: id(46),
                items: dish.mayContain.map((name, index) => ({
                  allergenReference: id(60 + index),
                  code: "SYNTHETIC_" + String(index),
                  name,
                  classification: "CrossContactPossible",
                })),
                allergenFreeClaim: false,
                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
              },
              displayPrice: {
                status: "Available",
                amount: dish.priceDollars,
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
  };
}

interface Table {
  dish: Dish;
  quotes: number;
  sent: number;
  /** Pricing and the checkout start answer that the dish can't be sold now. */
  soldOut: boolean;
  /** The subtotal of the quote the checkout (the round) was started on. */
  sessionSubtotal: bigint | null;
}

async function stubTable(page: Page, timing: "PayLater" | "PayFirst", dish: Dish) {
  const table: Table = { dish, quotes: 0, sent: 0, soldOut: false, sessionSubtotal: null };
  /** As the Store inside the hold: nothing changed since the last quote answers that same quote. */
  let held: { reference: string; key: string } | undefined;
  const issued = new Map<string, bigint>();
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const now = new Date().toISOString();
  const cents = () => BigInt(Math.round(Number(table.dish.priceDollars) * 100)) * 2n;
  let placed = false;
  let first: { subtotal: bigint; dish: Dish } | undefined;
  const json = (value: unknown) => ({
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill(json({ schemaVersion: 1, orderMessages: { sms: false, email: false } })),
  );
  await page.route("**/bff/customer/payment-configuration", (route) =>
    route.fulfill(
      json({
        schemaVersion: 1,
        mode: "stripe",
        publishableKey: "pk_test_SyntheticBrowserOnly",
        returnUrl: "https://synthetic-return.invalid/return",
        wallets: false,
        internalTestEntry: false,
      }),
    ),
  );
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Table Store",
        publicStoreReference: publicStore,
        publicTableReference: id(5),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: expiresAt,
        csrfToken: "d".repeat(43),
      },
    }),
  );
  await page.route(`**/api/v1/public/stores/${publicStore}/menu**`, (route) =>
    route.fulfill({ status: 200, json: menu(table.dish) }),
  );
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) =>
    route.fulfill({
      status: 200,
      json: {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: placed ? 4 : 3,
          orderType: "DineIn",
          serviceMode: "DineIn",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Table Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: placed
            ? []
            : [
                {
                  cartItemReference: id(2),
                  sellableReference: id(3),
                  displayName: table.dish.name,
                  quantity: 2,
                  configuration: [],
                  customerNote: null,
                  lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
                  warnings: [],
                },
              ],
          quote: null,
          warnings: [],
        },
      },
    }),
  );
  await page.route("**/api/v1/carts/*/quote", (route) => {
    table.quotes += 1;
    // As on v15: staff marked the dish "Sold out today" while the guest was at checkout.
    if (table.soldOut)
      return route.fulfill({
        status: 409,
        json: {
          schemaVersion: 1,
          error: {
            code: "quote_item_unavailable",
            messageKey: "customer.quote.item_unavailable",
            line: { cartItemReference: id(2) },
          },
        },
      });
    const subtotal = cents();
    const tax = (subtotal * 13n + 50n) / 100n;
    // As the Store: the first quote for the line is its record of what the guest was first shown;
    // every later quote says it, and whether the dish is shown differently now.
    first ??= { subtotal, dish: { ...table.dish, mayContain: [...table.dish.mayContain] } };
    const zhChanged = table.dish.nameZh !== undefined && first.dish.nameZh !== table.dish.nameZh;
    const renamed = [
      ...(table.dish.nameZh !== undefined && first.dish.name !== table.dish.name
        ? [{ locale: "en-CA", from: first.dish.name, to: table.dish.name }]
        : []),
      ...(zhChanged
        ? [{ locale: "zh-Hans-CA", from: first.dish.nameZh ?? "", to: table.dish.nameZh ?? "" }]
        : []),
    ];
    const changes = [
      ...(first.dish.name === table.dish.name && !zhChanged ? [] : ["Name"]),
      ...(first.dish.mayContain.join() === table.dish.mayContain.join() ? [] : ["Allergens"]),
    ];
    const key = JSON.stringify([String(subtotal), table.dish]);
    if (held?.key !== key) held = { reference: id(100 + table.quotes), key };
    issued.set(held.reference, subtotal);
    return route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        quote: {
          quoteReference: held.reference,
          quoteVersion: 2,
          cartVersion: 3,
          currency: "CAD",
          subtotal: { amountMinor: String(subtotal), currency: "CAD" },
          discount: { amountMinor: "0", currency: "CAD" },
          tax: { amountMinor: String(tax), currency: "CAD" },
          fee: { amountMinor: "0", currency: "CAD" },
          total: { amountMinor: String(subtotal + tax), currency: "CAD" },
          expiresAt,
          warnings: [],
          blockingReasons: [],
          lines: [
            {
              cartItemReference: id(2),
              quantity: 2,
              subtotal: { amountMinor: String(subtotal), currency: "CAD" },
            },
          ],
          ...(table.quotes === 1
            ? {}
            : {
                sinceAdded: [
                  {
                    cartItemReference: id(2),
                    quantity: 2,
                    subtotal: { amountMinor: String(first.subtotal), currency: "CAD" },
                    changes,
                    ...(renamed.length === 0 ? {} : { renamed }),
                  },
                ],
              }),
          priceChange: null,
        },
      },
    });
  });
  await page.route("**/bff/customer/checkout-details/current", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        checkout: { cartReference: id(1), cartVersion: 3, orderType: "DineIn", details: null },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details/policy", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        policy: {
          cartReference: id(1),
          cartVersion: 3,
          orderType: "DineIn",
          checkedAt: new Date(Date.now() - 1000).toISOString(),
          validUntil: expiresAt,
          documents: [],
        },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details", async (route) => {
    const request = route.request(),
      body = request.postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        details: {
          operationReference: request.headers()["idempotency-key"],
          detailsReference: body.detailsReference,
          detailsVersion: 1,
          cartReference: id(1),
          cartVersion: 3,
          quoteReference: body.quoteReference,
          quoteVersion: 2,
          orderType: "DineIn",
          receiptChoice: "InSession",
          recordedAt: new Date().toISOString(),
        },
      },
    });
  });
  let currentQuote = "";
  const session = (quoteReference: string) => ({
    schemaVersion: 1,
    session: {
      checkoutSessionReference: id(10),
      cartReference: id(1),
      cartVersion: 3,
      quoteReference,
      quoteVersion: 2,
      createdAt: now,
    },
  });
  await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
    if (table.soldOut)
      return route.fulfill({
        status: 409,
        json: {
          schemaVersion: 1,
          error: {
            code: "checkout_session_item_unavailable",
            messageKey: "customer.checkoutSession.item_unavailable",
            line: { cartItemReference: id(2), available: null, sharedStock: false },
          },
        },
      });
    const body = route.request().postDataJSON() as { quoteReference: string };
    currentQuote = body.quoteReference;
    table.sessionSubtotal = issued.get(body.quoteReference) ?? null;
    return route.fulfill({ status: 200, json: session(body.quoteReference) });
  });
  await page.route("**/api/v1/checkout-sessions/*", (route) =>
    route.fulfill({ status: 200, json: session(currentQuote) }),
  );
  await page.route("**/api/v1/checkout-sessions/*/payment-intents", async (route) => {
    table.sent += 1;
    placed = true;
    await route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        round: {
          checkoutSessionReference: id(10),
          orderReference: id(20),
          status: "Sent",
          total: { amountMinor: "0", currency: "CAD" },
        },
      },
    });
  });
  await page.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill(
      json({
        schemaVersion: 1,
        session: {
          tableLabel: "12",
          orderNumber: null,
          checkedAt: new Date().toISOString(),
          paymentTiming: timing,
          rounds: [],
          summary: null,
        },
      }),
    ),
  );
  await page.route("**/api/v1/dine-in/table-payment", (route) =>
    route.fulfill(
      json({
        schemaVersion: 1,
        payment: {
          tableLabel: "12",
          checkingOut: false,
          rounds: [],
          owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
          consistent: true,
          state: "NotPaid",
          attempt: null,
          receipt: null,
        },
      }),
    ),
  );
  await page.route("**/api/v1/dine-in/staff-call", (route) =>
    route.fulfill(
      json({
        schemaVersion: 1,
        staffCall: { open: null, recentlyClosed: null, nextCallAt: null },
      }),
    ),
  );
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill(json({ schemaVersion: 1, invitation: { canInvite: false } })),
  );
  return table;
}

/** A full page load at the table (the guest reloads, or opens the page again from the QR). */
async function openAtTable(page: Page, path: "/cart" | "/checkout") {
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Table Store", exact: true }),
  ).toBeVisible();
  await page.evaluate((target) => {
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

const noodles = (): Dish => ({ name: "Synthetic noodles", priceDollars: "10.00", mayContain: [] });

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet", width: 1024, height: 768, touch: true },
  { name: "phone", width: 390, height: 844, touch: true },
]) {
  test.describe("@production price-hold-dish-changes " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });

    test("a price listed higher while the cart is open is named after a reload and ticked before Place order", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const table = await stubTable(page, "PayLater", noodles());
      await openAtTable(page, "/cart");
      const main = page.getByRole("main");
      const place = main.getByRole("button", { name: "Place order", exact: true });
      await expect(main.getByText("$20.00", { exact: true }).first()).toBeVisible();
      await expect(place).toBeEnabled();
      // The cart on screen was priced: the Store keeps that price and remembers it was shown.
      await expect.poll(() => table.quotes).toBe(1);
      // The owner lists $10.25; after the hold, the guest reloads the cart.
      table.dish = { ...table.dish, priceDollars: "10.25" };
      await openAtTable(page, "/cart");
      const changes = main.locator(".cart-price-changes");
      await expect(changes.getByText("Prices changed since you added these:")).toBeVisible();
      await expect(changes.getByText("Synthetic noodles: $20.00 → $20.50")).toBeVisible();
      // The screen reader hears the same, never "up to date".
      await expect(page.locator(".sr-only[role=status]")).toHaveText(
        "Prices changed since you added these:",
      );
      await expect(page.getByText("Your cart is up to date.")).toHaveCount(0);
      await expect(place).toBeDisabled();
      await expect(main.getByText("Tick the box above to place your order.")).toBeVisible();
      await noSideScroll(page);
      await expectNoInternalText(page);
      expect(table.sent).toBe(0);
      await main.getByRole("checkbox", { name: "I have read these changes" }).check();
      await expect(place).toBeEnabled();
      await place.click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      expect(table.sent).toBe(1);
      expect(failures).toEqual([]);
    });

    test("a dish renamed and given an allergen while the table cart is open stops Place order until the guest ticks it", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const table = await stubTable(page, "PayLater", noodles());
      await openAtTable(page, "/cart");
      const main = page.getByRole("main");
      const place = main.getByRole("button", { name: "Place order", exact: true });
      await expect(place).toBeEnabled();
      await expect.poll(() => table.quotes).toBe(1);
      // Staff rename the dish and set sesame to "May contain", then list it; the guest does not
      // reload and taps Place order at the same price.
      table.dish = {
        name: "Synthetic house noodles",
        priceDollars: "10.00",
        mayContain: ["Sesame seeds"],
      };
      await place.click();
      await expect(
        main.getByText(
          "A dish changed since you added it. Nothing was ordered. Read the changes above, tick the box, then place your order.",
        ),
      ).toBeVisible();
      await expect(main.getByText("Changed since you added it:")).toBeVisible();
      await expect(
        main.getByText(/renamed since you added it\..*allergens now: May contain Sesame seeds\./u),
      ).toBeVisible();
      await expect(place).toBeDisabled();
      expect(table.sent).toBe(0);
      await noSideScroll(page);
      await expectNoInternalText(page);
      await main.getByRole("checkbox", { name: "I have read these changes" }).check();
      await expect(place).toBeEnabled();
      await place.click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      expect(table.sent).toBe(1);
      expect(failures).toEqual([]);
    });

    test("a price cut listed while the table cart is open is what the round is placed at", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const table = await stubTable(page, "PayLater", noodles());
      await openAtTable(page, "/cart");
      const main = page.getByRole("main");
      const place = main.getByRole("button", { name: "Place order", exact: true });
      await expect(main.getByText("$20.00", { exact: true }).first()).toBeVisible();
      await expect.poll(() => table.quotes).toBe(1);
      // The owner lowers the dish to $9.50 and lists it; the guest taps without reloading.
      table.dish = { ...table.dish, priceDollars: "9.50" };
      await place.click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      expect(table.sent).toBe(1);
      // Priced again at the tap: the round went at today's lower price, never the $20.00 shown.
      expect(table.sessionSubtotal).toBe(1900n);
      expect(failures).toEqual([]);
    });

    test("a dish renamed and given an allergen is named with its allergens now, and ticked before paying", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const table = await stubTable(page, "PayFirst", noodles());
      // The guest opens checkout: the price is confirmed and kept.
      await openAtTable(page, "/checkout");
      const main = page.getByRole("main");
      await expect(main.getByText(/Your price is kept for/u)).toBeVisible();
      // Staff rename the dish and set sesame to "May contain", then list it; the guest reloads.
      table.dish = {
        name: "Synthetic house noodles",
        priceDollars: "10.00",
        mayContain: ["Sesame seeds"],
      };
      await openAtTable(page, "/checkout");
      const changed =
        "Synthetic house noodles was renamed since you added it. Synthetic house noodles allergens now: May contain Sesame seeds.";
      await expect(main.getByText("Changed since you added it:")).toBeVisible();
      await expect(main.getByText(changed)).toBeVisible();
      await main.getByRole("button", { name: "No tip", exact: true }).click();
      const pay = main.getByRole("button", { name: /Continue to payment/u });
      await expect(pay).toBeDisabled();
      // v15 2026-11-11 b10: the greyed button says why, right under it.
      const why = main.getByText("Tick the box above to continue to payment.");
      await expect(why).toBeVisible();
      await expect(pay).toHaveAttribute("aria-describedby", "checkout-tick-changes");
      await main.getByRole("checkbox", { name: "I have read these changes" }).check();
      await expect(pay).toBeEnabled();
      await expect(why).toHaveCount(0);
      await noSideScroll(page);
      await expectNoInternalText(page);
      expect(failures).toEqual([]);
    });

    test("v15 b10: a dish whose Chinese name alone changed says so to an English reader, never the same name twice", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const table = await stubTable(page, "PayFirst", { ...noodles(), nameZh: "拉面" });
      await openAtTable(page, "/checkout");
      const main = page.getByRole("main");
      await expect(main.getByText(/Your price is kept for/u)).toBeVisible();
      table.dish = { ...noodles(), nameZh: "招牌拉面" };
      await openAtTable(page, "/checkout");
      await expect(main.getByText("Changed since you added it:")).toBeVisible();
      await expect(
        main.getByText(
          "Synthetic noodles: its Chinese name changed from 拉面 to 招牌拉面. The name you see here is the same.",
        ),
      ).toBeVisible();
      await expect(main.getByText("Synthetic noodles was renamed since you added it.")).toHaveCount(
        0,
      );
      await main.getByRole("button", { name: "No tip", exact: true }).click();
      const pay = main.getByRole("button", { name: /Continue to payment/u });
      await expect(pay).toBeDisabled();
      await expect(main.getByText("Tick the box above to continue to payment.")).toBeVisible();
      await main.getByRole("checkbox", { name: "I have read these changes" }).check();
      await expect(pay).toBeEnabled();
      await noSideScroll(page);
      expect(failures).toEqual([]);
    });

    test("a dish sold out at checkout leads back to the cart once", async ({ page }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const table = await stubTable(page, "PayFirst", noodles());
      table.soldOut = true;
      await openAtTable(page, "/checkout");
      const main = page.getByRole("main");
      await expect(main.getByRole("alert").filter({ hasText: "Synthetic noodles" })).toBeVisible();
      await expect(main.getByRole("link", { name: "Change your cart", exact: true })).toHaveCount(
        1,
      );
      await noSideScroll(page);
      await expectNoInternalText(page);
      expect(failures).toEqual([]);
    });
  });
}
