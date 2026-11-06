import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 DEC-MERCHANT-LOCK-SCOPE: an owner can list with the tables full. A guest part way through
// ordering is never stuck on a price that has gone. At a table that pays at the end the cart places
// its round in one tap: a menu that moved is priced again by itself, the round goes once, and the
// guest is asked only if the total went up. At a table that pays first the checkout page prices
// again, says why, and the guest checks the total and pays. Nothing is sent or charged in between.
// Synthetic HTTP interception on the production PWA; the database acceptance test
// (listing-crosses-open-cart) proves the server's side with the real compositions.
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => "018f8a10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);
const notice = "The restaurant just updated its menu, so we priced your order again.";
const syntheticStripe = `window.Stripe = function() { return {
  elements: function() { return {
    create: function() {
      var handlers = {}, host;
      return {
        on: function(event, callback) { handlers[event] = callback; },
        mount: function(target) {
          host = target; host.textContent = "Synthetic secure card component";
          queueMicrotask(function() { handlers.ready(); });
        },
        destroy: function() { if (host) host.textContent = ""; }
      };
    },
    submit: async function() { return {}; }
  }; },
  confirmPayment: async function() { return { paymentIntent: { status: "succeeded" } }; }
}; };`;

interface Refusals {
  /** The checkout start is refused this many times. */
  startRefused: number;
  /** The send or payment is refused this many times. */
  sendRefused: number;
  /** What the menu update did to the price: the quotes after the first one come to this. */
  repriced?: { readonly subtotalMinor: string; readonly totalMinor: string };
}
interface Seen {
  quotes: number;
  started: string[];
  /** Every send or payment start, refused or not, by its idempotency key. */
  sends: (string | undefined)[];
  /** The sends that placed a round or opened a payment. */
  accepted: number;
}

/** The cart's dish on the menu at $10.00, as the guest saw it before the owner listed. */
function pricedMenu() {
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
              name: "Synthetic noodles",
              description: null,
              photo: null,
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {
                registryVersionReference: id(46),
                items: [],
                allergenFreeClaim: false,
                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
              },
              displayPrice: { status: "Available", amount: "10.00", currency: "CAD", reason: null },
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

async function stubTable(page: Page, timing: "PayLater" | "PayFirst", refusals: Refusals) {
  const seen: Seen = { quotes: 0, started: [], sends: [], accepted: 0 };
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const now = new Date().toISOString();
  // As the server: a round placed takes its dishes out of the cart.
  let placed = false;
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ schemaVersion: 1, orderMessages: { sms: false, email: false } }),
    }),
  );
  await page.route("**/bff/customer/payment-configuration", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        mode: "stripe",
        publishableKey: "pk_test_SyntheticBrowserOnly",
        returnUrl: "https://synthetic-return.invalid/return",
        wallets: false,
        internalTestEntry: false,
      },
    }),
  );
  await page.route("https://js.stripe.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: syntheticStripe }),
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
    route.fulfill({ status: 200, json: pricedMenu() }),
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
                  displayName: "Synthetic noodles",
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
    seen.quotes += 1;
    const price =
      seen.quotes > 1 && refusals.repriced
        ? refusals.repriced
        : { subtotalMinor: "2000", totalMinor: "2260" };
    return route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        quote: {
          quoteReference: id(100 + seen.quotes),
          quoteVersion: 1,
          cartVersion: 3,
          currency: "CAD",
          subtotal: { amountMinor: price.subtotalMinor, currency: "CAD" },
          discount: { amountMinor: "0", currency: "CAD" },
          tax: { amountMinor: "260", currency: "CAD" },
          fee: { amountMinor: "0", currency: "CAD" },
          total: { amountMinor: price.totalMinor, currency: "CAD" },
          expiresAt,
          warnings: [],
          blockingReasons: [],
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
          quoteVersion: 1,
          orderType: "DineIn",
          receiptChoice: "InSession",
          recordedAt: new Date().toISOString(),
        },
      },
    });
  });
  // As the server: each checkout opened is a new one, for the quote it was opened with.
  let opened = 0;
  const session = (quoteReference: string) => ({
    schemaVersion: 1,
    session: {
      checkoutSessionReference: id(10 + opened),
      cartReference: id(1),
      cartVersion: 3,
      quoteReference,
      quoteVersion: 1,
      createdAt: now,
    },
  });
  let currentQuote = "";
  await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
    const body = route.request().postDataJSON() as { quoteReference: string };
    seen.started.push(body.quoteReference);
    if (refusals.startRefused > 0) {
      refusals.startRefused -= 1;
      return route.fulfill({
        status: 409,
        json: {
          schemaVersion: 1,
          error: {
            code: "checkout_session_requote_required",
            messageKey: "customer.checkoutSession.requote_required",
          },
        },
      });
    }
    currentQuote = body.quoteReference;
    opened += 1;
    return route.fulfill({ status: 200, json: session(body.quoteReference) });
  });
  await page.route("**/api/v1/checkout-sessions/*", (route) =>
    route.fulfill({ status: 200, json: session(currentQuote) }),
  );
  await page.route("**/api/v1/checkout-sessions/*/payment-intents", async (route) => {
    const request = route.request();
    seen.sends.push(request.headers()["idempotency-key"]);
    if (refusals.sendRefused > 0) {
      refusals.sendRefused -= 1;
      await route.fulfill({
        status: 422,
        json: {
          schemaVersion: 1,
          error: {
            code: "payment_requote_required",
            messageKey: "customer.payment.requote_required",
          },
        },
      });
      return;
    }
    seen.accepted += 1;
    if (timing === "PayLater") {
      placed = true;
      await route.fulfill({
        status: 201,
        json: {
          schemaVersion: 1,
          round: {
            checkoutSessionReference: id(10 + opened),
            orderReference: id(20),
            status: "Sent",
            total: { amountMinor: "2260", currency: "CAD" },
          },
        },
      });
      return;
    }
    await route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        payment: {
          checkoutSessionReference: id(10 + opened),
          paymentIntentReference: id(11),
          orderReference: id(20),
          creationStatus: "Created",
          total: { amountMinor: refusals.repriced?.totalMinor ?? "2260", currency: "CAD" },
        },
      },
    });
  });
  await page.route("**/api/v1/checkout-sessions/*/payment-handoff", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, clientSecret: "pi_SyntheticStart_secret_SyntheticOnly" },
    }),
  );
  await page.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        session: {
          tableLabel: "12",
          orderNumber: null,
          checkedAt: new Date().toISOString(),
          paymentTiming: timing,
          rounds: [],
          summary: null,
        },
      },
    }),
  );
  await page.route("**/api/v1/dine-in/table-payment", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: {
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
      },
    }),
  );
  await page.route("**/api/v1/dine-in/staff-call", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, staffCall: { open: null, recentlyClosed: null, nextCallAt: null } },
    }),
  );
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, invitation: { canInvite: false } },
    }),
  );
  return seen;
}

async function enterTable(page: Page, path: "/cart" | "/checkout") {
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Table Store", exact: true }),
  ).toBeVisible();
  await page.evaluate((target) => {
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** Never "may have been placed", "not placed" or a code: the menu update isn't the guest's problem. */
async function expectNoFailureSaid(page: Page) {
  const main = page.getByRole("main");
  await expect(main).not.toContainText("We couldn’t confirm your order");
  await expect(main).not.toContainText("We couldn’t place your order");
  await expectNoInternalText(page);
}

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production A menu update while a guest orders " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });

    for (const refused of ["send", "checkout start"] as const) {
      test(`one tap from the cart: the ${refused} finds the menu moved, it is priced again and placed once`, async ({
        page,
      }) => {
        const failures: string[] = [];
        page.on("pageerror", () => failures.push("page error"));
        const pages: string[] = [];
        page.on("framenavigated", (frame) => pages.push(new URL(frame.url()).pathname));
        const seen = await stubTable(page, "PayLater", {
          startRefused: refused === "checkout start" ? 1 : 0,
          sendRefused: refused === "send" ? 1 : 0,
        });
        await enterTable(page, "/cart");
        const place = page.getByRole("button", { name: "Place order", exact: true });
        await expect(place).toBeEnabled();
        await place.click();
        await expect(page).toHaveURL(/\/dine-in\/session$/u);
        await expect(
          page.getByRole("main").getByRole("status").filter({ hasText: "Order placed." }),
        ).toBeVisible();
        await expectNoFailureSaid(page);
        // The price stood, so nothing to ask: priced again once, the round placed once.
        expect(pages).not.toContain("/checkout");
        expect(seen.quotes).toBe(2);
        expect(seen.started).toEqual([id(101), id(102)]);
        expect(seen.accepted).toBe(1);
        expect(seen.sends).toHaveLength(refused === "send" ? 2 : 1);
        if (refused === "send") expect(seen.sends[0]).not.toBe(seen.sends[1]);
        expect(failures).toEqual([]);
      });
    }

    test("one tap from the cart: a menu update that raised the price asks once, then places it once", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const seen = await stubTable(page, "PayLater", {
        startRefused: 0,
        sendRefused: 1,
        repriced: { subtotalMinor: "2200", totalMinor: "2486" },
      });
      await enterTable(page, "/cart");
      await page.getByRole("button", { name: "Place order", exact: true }).click();
      const main = page.getByRole("main");
      await expect(
        main.getByText("The price changed since you added this. It now comes to $24.86 with tax."),
      ).toBeVisible();
      await expectNoFailureSaid(page);
      // Nothing was placed at the old price, and nothing goes at the new one without the guest.
      expect(seen.accepted).toBe(0);
      expect(seen.sends).toHaveLength(1);
      await page.getByRole("button", { name: "Place order · $24.86", exact: true }).click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      expect(seen.quotes).toBe(2);
      expect(seen.started).toEqual([id(101), id(102)]);
      expect(seen.accepted).toBe(1);
      expect(seen.sends).toHaveLength(2);
      expect(failures).toEqual([]);
    });

    test("pay first: the checkout start finds the menu moved, the page prices again, says so, and the guest pays", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const seen = await stubTable(page, "PayFirst", { startRefused: 1, sendRefused: 0 });
      await enterTable(page, "/checkout");
      const noTip = page.getByRole("button", { name: "No tip", exact: true });
      const pay = page.getByRole("button", { name: /Continue to payment · \$22\.60/u });
      await noTip.click();
      await expect(page.getByText(notice, { exact: false })).toHaveCount(0);
      await pay.click();
      await expect(page.getByText(notice, { exact: false })).toBeVisible();
      await expect(page).toHaveURL(/\/checkout$/u);
      await expectNoInternalText(page);
      expect(seen.quotes).toBe(2);
      expect(seen.sends).toHaveLength(0);
      // The tip chosen for the old price goes with it: the guest chooses again and pays.
      await noTip.click();
      await pay.click();
      await expect(page).toHaveURL(/\/checkout\/payment$/u);
      const main = page.getByRole("main");
      await expect(main.getByText("Synthetic secure card component")).toBeVisible();
      await expect(main.getByText("$22.60", { exact: true })).toBeVisible();
      expect(seen.started).toEqual([id(101), id(102)]);
      expect(seen.accepted).toBe(1);
      expect(failures).toEqual([]);
    });

    test("pay first: the payment page says the menu was just updated and leads back to checkout", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const seen = await stubTable(page, "PayFirst", { startRefused: 0, sendRefused: 1 });
      await enterTable(page, "/checkout");
      await page.getByRole("button", { name: "No tip", exact: true }).click();
      await page.getByRole("button", { name: /Continue to payment · \$22\.60/u }).click();
      await expect(page).toHaveURL(/\/checkout\/payment$/u);
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: "The menu was just updated" })).toBeVisible();
      await expect(main).toContainText(
        "so you haven’t been charged. Go back to checkout to see your total and pay.",
      );
      await expect(main).not.toContainText("We couldn’t confirm your payment");
      await expectNoInternalText(page);
      // The dishes are still in the cart: back to checkout, never to the table page.
      const back = main.getByRole("link", { name: "Back to checkout", exact: true });
      await expect(back).toBeVisible();
      await expect(main.getByRole("link", { name: "Back to your table" })).toHaveCount(0);
      await back.click();
      await expect(page).toHaveURL(/\/checkout$/u);
      await expect.poll(() => seen.quotes).toBe(2);
      // Priced again, the guest pays from here.
      await page.getByRole("button", { name: "No tip", exact: true }).click();
      await page.getByRole("button", { name: /Continue to payment · \$22\.60/u }).click();
      await expect(page).toHaveURL(/\/checkout\/payment$/u);
      await expect(main.getByText("Synthetic secure card component")).toBeVisible();
      expect(seen.started).toEqual([id(101), id(102)]);
      expect(seen.sends).toHaveLength(2);
      expect(seen.accepted).toBe(1);
      expect(failures).toEqual([]);
    });
  });
}
