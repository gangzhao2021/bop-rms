import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 item 2: every wait on the way to paying ends in a state with a next action, and the page
// says what was charged only when it knows. Synthetic HTTP and Stripe SDK fixtures exercise the
// built PWA; a real Provider's failures are not reachable here.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });

const id = (n: number) => "018f8b00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const session = id(10);
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

type Answer = (route: Route, call: number) => Promise<void>;
const created: Answer = (route) =>
  route.fulfill({
    status: 201,
    json: {
      schemaVersion: 1,
      payment: {
        checkoutSessionReference: session,
        paymentIntentReference: id(11),
        orderReference: id(12),
        creationStatus: "Created",
        total: { amountMinor: "2260", currency: "CAD" },
      },
    },
  });
const refused =
  (status: number, code?: string, headers: Record<string, string> = {}): Answer =>
  (route) =>
    route.fulfill({
      status,
      headers,
      json: {
        schemaVersion: 1,
        error: { code: code ?? "payment_service_unavailable", messageKey: "customer.payment" },
      },
    });

async function checkout(
  page: Page,
  options: {
    readonly channel: "DineIn" | "Pickup";
    readonly intents: Answer;
    /** What a cart read answers once the payment page asks (the round may have emptied it). */
    readonly cartLines?: () => number;
    readonly stripe?: (route: Route) => Promise<void>;
  },
) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const dineIn = options.channel === "DineIn";
  const intentCalls: { key: string | undefined; body: unknown }[] = [];
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, orderMessages: { sms: false, email: false } },
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
    options.stripe
      ? options.stripe(route)
      : route.fulfill({ contentType: "application/javascript", body: syntheticStripe }),
  );
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Store",
        publicStoreReference: id(4),
        publicTableReference: dineIn ? id(5) : null,
        channel: options.channel,
        operatingState: "Open",
        availableServiceModes: [options.channel],
        locale: "en-CA",
        contextExpiresAt: expiresAt,
        csrfToken: "d".repeat(43),
      },
    }),
  );
  const line = {
    cartItemReference: id(2),
    sellableReference: id(3),
    displayName: "Synthetic noodles",
    quantity: 1,
    configuration: [],
    customerNote: null,
    lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
    warnings: [],
  };
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) => {
    const lines = options.cartLines?.() ?? 1;
    return route.fulfill({
      status: 200,
      json: {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: 3,
          orderType: options.channel,
          serviceMode: options.channel,
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: lines === 0 ? [] : [line],
          quote: null,
          warnings: [],
        },
      },
    });
  });
  await page.route("**/api/v1/carts/*/quote", (route) =>
    route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        tips: { enabled: false, tierPercents: [10, 15, 18] },
        quote: {
          quoteReference: id(6),
          quoteVersion: 1,
          cartVersion: 3,
          currency: "CAD",
          subtotal: { amountMinor: "2000", currency: "CAD" },
          discount: { amountMinor: "0", currency: "CAD" },
          tax: { amountMinor: "260", currency: "CAD" },
          fee: { amountMinor: "0", currency: "CAD" },
          total: { amountMinor: "2260", currency: "CAD" },
          expiresAt,
          warnings: [],
          blockingReasons: [],
          priceChange: null,
        },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details/current", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        checkout: {
          cartReference: id(1),
          cartVersion: 3,
          orderType: options.channel,
          details: dineIn
            ? null
            : {
                detailsReference: id(7),
                detailsVersion: 1,
                cartReference: id(1),
                cartVersion: 3,
                quoteReference: id(6),
                quoteVersion: 1,
                pickupContact: { name: "Synthetic Guest", channel: "Phone", value: "+14165550123" },
                receipt: { choice: "InSession", email: null },
                policies: [],
                recordedAt: new Date(Date.now() - 1000).toISOString(),
              },
        },
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
          orderType: options.channel,
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
          detailsVersion: Number(body.expectedVersion) + 1,
          cartReference: id(1),
          cartVersion: 3,
          quoteReference: body.quoteReference,
          quoteVersion: 1,
          orderType: options.channel,
          receiptChoice: "InSession",
          recordedAt: new Date().toISOString(),
        },
      },
    });
  });
  const sessionView = {
    schemaVersion: 1,
    session: {
      checkoutSessionReference: session,
      cartReference: id(1),
      cartVersion: 3,
      quoteReference: id(6),
      quoteVersion: 1,
      createdAt: new Date().toISOString(),
    },
  };
  await page.route("**/api/v1/carts/*/checkout-sessions", (route) =>
    route.fulfill({ status: 201, json: sessionView }),
  );
  await page.route(`**/api/v1/checkout-sessions/${session}`, (route) =>
    route.fulfill({ status: 200, json: sessionView }),
  );
  await page.route(`**/api/v1/checkout-sessions/${session}/payment-intents`, async (route) => {
    const request = route.request();
    intentCalls.push({ key: request.headers()["idempotency-key"], body: request.postDataJSON() });
    await options.intents(route, intentCalls.length);
  });
  await page.route(`**/api/v1/checkout-sessions/${session}/payment-handoff`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, clientSecret: "pi_SyntheticStart_secret_SyntheticOnly" },
    }),
  );
  await page.route("**/api/v1/dine-in/staff-call", (route) =>
    dineIn
      ? route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 1,
            staffCall: { open: null, recentlyClosed: null, nextCallAt: null },
          },
        })
      : route.fulfill({
          status: 404,
          headers: { "cache-control": "no-store" },
          json: { schemaVersion: 1, error: { code: "dining_staff_call_not_found" } },
        }),
  );
  return { intentCalls };
}

/** From the entry to the guest's tap on the checkout page. */
async function tapContinue(page: Page) {
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { level: 1, name: "Synthetic Store", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    history.pushState(null, "", "/checkout");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const proceed = page.getByRole("button", { name: /Continue to payment/u });
  await expect(proceed).toBeEnabled();
  await proceed.click();
}
/** From the entry to the payment page, one guest tap on the checkout page. */
async function goToPayment(page: Page) {
  await tapContinue(page);
  await expect(page).toHaveURL(/\/checkout\/payment$/u);
}

const failedOnce =
  (first: Answer): Answer =>
  (route, call) =>
    call === 1 ? first(route, call) : created(route, call);

test("@production a payment that can’t start says nothing was charged and offers a retry", async ({
  page,
}) => {
  const { intentCalls } = await checkout(page, {
    channel: "Pickup",
    intents: failedOnce(refused(503)),
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "We couldn’t start your payment" })).toBeVisible();
  await expect(main).toContainText(
    "This order hasn’t been charged, and it hasn’t gone to the kitchen.",
  );
  await expect(main).toContainText("ask a staff member: they can take your order and payment.");
  await expect(main).not.toContainText("Calculating");
  await expect(main).not.toContainText("You haven’t been charged");
  // A pickup guest's dishes are still in the cart; there's no table page and no staff call.
  await expect(main.getByRole("link", { name: "Back to your cart" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Back to checkout" })).toHaveCount(0);
  await expect(main.getByText("Need a staff member?")).toHaveCount(0);
  await expectNoInternalText(page);
  await main.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(main.getByText("Synthetic secure card component")).toBeVisible();
  await expect(main.getByText("$22.60", { exact: true })).toBeVisible();
  expect(intentCalls).toHaveLength(2);
  expect(intentCalls[1]?.key).toBe(intentCalls[0]?.key);
  expect(intentCalls[1]?.body).toEqual(intentCalls[0]?.body);
});

test("@production the same failure reads in Chinese", async ({ page }) => {
  await checkout(page, { channel: "Pickup", intents: refused(503) });
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { level: 1, name: "Synthetic Store", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "切换到中文" }).click();
  await page.evaluate(() => {
    history.pushState(null, "", "/checkout");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const proceed = page.getByRole("button", { name: /去付款/u });
  await expect(proceed).toBeEnabled();
  await proceed.click();
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "暂时无法开始付款" })).toBeVisible();
  await expect(main).toContainText("这一单没有扣款，也还没有送到厨房。");
  await expect(main).not.toContainText("Calculating");
  await expect(main).not.toContainText("Try again");
  await expect(main).not.toContainText("charged");
});

test("@production a busy store says it is still working, then fails plainly", async ({ page }) => {
  await page.clock.install();
  const { intentCalls } = await checkout(page, {
    channel: "Pickup",
    intents: refused(503, undefined, { "retry-after": "5" }),
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByText("Preparing your payment…")).toBeVisible();
  // Nothing extra for an ordinary wait.
  await expect(main.getByText("Still working on it.", { exact: false })).toHaveCount(0);
  await page.clock.runFor(8_000);
  await expect(
    main.getByText("Still working on it. This order hasn’t been charged.", { exact: true }),
  ).toBeVisible();
  await expect(main).not.toContainText("restaurant");
  // The wait through a menu listing is kept: about half a minute of asking with the same key.
  for (let wait = 0; wait < 12 && intentCalls.length < 11; wait += 1) {
    const before = intentCalls.length;
    await page.clock.runFor(3_100);
    await expect.poll(() => intentCalls.length >= before).toBe(true);
  }
  await expect(main.getByRole("heading", { name: "We couldn’t start your payment" })).toBeVisible();
  expect(new Set(intentCalls.map((call) => call.key)).size).toBe(1);
  const afterWait = intentCalls.length;
  expect(afterWait).toBeGreaterThanOrEqual(3);
  expect(afterWait).toBeLessThanOrEqual(11);
  // Someone who already waited isn't asked to wait as long again: the tap ends plainly in seconds.
  await main.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(main.getByText("Preparing your payment…")).toBeVisible();
  for (let wait = 0; wait < 6; wait += 1) await page.clock.runFor(3_100);
  await expect(main.getByRole("heading", { name: "We couldn’t start your payment" })).toBeVisible();
  expect(intentCalls.length - afterWait).toBeLessThanOrEqual(4);
});

test("@production when the Provider fails after the round was placed, the panel points to the table", async ({
  page,
}) => {
  // /payment-intents submits the round and empties the cart before it calls the Provider.
  let placed = false;
  const { intentCalls } = await checkout(page, {
    channel: "DineIn",
    cartLines: () => (placed ? 0 : 1),
    intents: (route, call) => {
      placed = true;
      return call === 1 ? refused(503)(route, call) : created(route, call);
    },
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "We couldn’t start your payment" })).toBeVisible();
  await expect(main).toContainText(
    "Your dishes are saved on your table page and go to the kitchen once paid.",
  );
  // Never an empty cart: the guest would order everything again.
  await expect(main.getByRole("link", { name: "See your table" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Back to your cart" })).toHaveCount(0);
  await expect(main.getByRole("link", { name: "Back to checkout" })).toHaveCount(0);
  // Asking for help is one tap for a seated guest.
  await expect(main.getByRole("heading", { name: "Need a staff member?" })).toBeVisible();
  await expectNoInternalText(page);
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `test-results/payment-start-failed-${width}.png`,
      fullPage: true,
    });
  }
  await main.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(main.getByText("Synthetic secure card component")).toBeVisible();
  expect(intentCalls[1]?.key).toBe(intentCalls[0]?.key);
});

test("@production a table whose dishes are still in the cart goes back to the cart", async ({
  page,
}) => {
  await checkout(page, { channel: "DineIn", intents: refused(503) });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "We couldn’t start your payment" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Back to your cart" })).toBeVisible();
  await expect(main).not.toContainText("saved on your table page");
});

test("@production last orders before any card says so, with the way back to where the dishes are", async ({
  page,
}) => {
  // The first start placed the round and then failed; by the guest's retry the kitchen had stopped.
  let placed = false;
  const { intentCalls } = await checkout(page, {
    channel: "DineIn",
    cartLines: () => (placed ? 0 : 1),
    intents: (route, call) => {
      placed = true;
      return call === 1
        ? refused(503)(route, call)
        : refused(409, "payment_store_closed")(route, call);
    },
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "We couldn’t start your payment" })).toBeVisible();
  await main.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    main.getByRole("heading", { name: "The store stopped taking orders" }),
  ).toBeVisible();
  // No card was offered in this tab, so this much is known.
  await expect(main).toContainText("so this order hasn’t been charged");
  await expect(main.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  await expect(main.getByRole("link", { name: "See your table" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Back to your cart" })).toHaveCount(0);
  await expect(main.getByRole("link", { name: "Back to checkout" })).toHaveCount(0);
  await expect(main.getByRole("heading", { name: "Need a staff member?" })).toBeVisible();
  await expectNoInternalText(page);
  expect(intentCalls[1]?.key).toBe(intentCalls[0]?.key);
});

test("@production last orders at pickup goes back to the cart, with no table to call from", async ({
  page,
}) => {
  await checkout(page, { channel: "Pickup", intents: refused(409, "payment_store_closed") });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "The store stopped taking orders" }),
  ).toBeVisible();
  await expect(main.getByRole("link", { name: "Back to your cart" })).toBeVisible();
  await expect(main.getByText("Need a staff member?")).toHaveCount(0);
});

test("@production a checkout whose order needs checking again says so, without a charge claim to break", async ({
  page,
}) => {
  await checkout(page, { channel: "Pickup", intents: refused(422) });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "Your order needs checking again" }),
  ).toBeVisible();
  await expect(main).toContainText("This order hasn’t been charged. Go back to check out again.");
  await expect(main.getByRole("link", { name: "Back to checkout" })).toBeVisible();
});

test("@production tips turned off after a table's round was placed points to the table, not an empty checkout", async ({
  page,
}) => {
  // The server places the round (emptying the cart) before it records the tip.
  let placed = false;
  await checkout(page, {
    channel: "DineIn",
    cartLines: () => (placed ? 0 : 1),
    intents: (route, call) => {
      placed = true;
      return refused(409, "payment_tips_turned_off")(route, call);
    },
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "The restaurant stopped taking tips" }),
  ).toBeVisible();
  await expect(main).toContainText("Pay for it from your table page, without a tip.");
  await expect(main).toContainText("saved on your table page");
  await expect(main.getByRole("link", { name: "See your table" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Back to checkout" })).toHaveCount(0);
  await expect(main.getByRole("heading", { name: "Need a staff member?" })).toBeVisible();
  await expectNoInternalText(page);
});

test("@production tips turned off at pickup goes back to checkout to pay without a tip", async ({
  page,
}) => {
  await checkout(page, { channel: "Pickup", intents: refused(409, "payment_tips_turned_off") });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main).toContainText("Go back to checkout to pay without a tip.");
  await expect(main.getByRole("link", { name: "Back to checkout" })).toBeVisible();
  await expect(main.getByText("Need a staff member?")).toHaveCount(0);
});

test("@production a table's order that needs checking again after its round was placed says to pay from the table", async ({
  page,
}) => {
  let placed = false;
  await checkout(page, {
    channel: "DineIn",
    cartLines: () => (placed ? 0 : 1),
    intents: (route, call) => {
      placed = true;
      return refused(422)(route, call);
    },
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "Your order needs checking again" }),
  ).toBeVisible();
  await expect(main).toContainText(
    "This order hasn’t been charged. Pay for it from your table page.",
  );
  await expect(main).not.toContainText("Go back to check out again");
  await expect(main.getByRole("link", { name: "See your table" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Back to checkout" })).toHaveCount(0);
});

test("@production staff moving the table while the round is sent says so, with the way back to check out again", async ({
  page,
}) => {
  // WP-2423 table-move-payment review (2026-11-06): the party was moved between preparing and
  // sending the round. Nothing was placed or charged; the guest checks out again at the new table.
  const { intentCalls } = await checkout(page, {
    channel: "DineIn",
    intents: refused(409, "payment_table_moved"),
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Your table was changed" })).toBeVisible();
  await expect(main).toContainText(
    "Staff moved your party to another table while you were paying, so you haven’t been charged.",
  );
  await expect(main).not.toContainText("The restaurant updated its menu");
  await expectNoInternalText(page);
  // Back to where the dishes are, to check out again (a new checkout, at the new table).
  await expect(main.getByRole("link", { name: /^Back to (your cart|checkout)$/u })).toBeVisible();
  await expect(main.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  expect(intentCalls).toHaveLength(1);
});

test("@production after a table move the guest checks out again at once, with the dishes still in the cart", async ({
  page,
}) => {
  // WP-2423 table-move-send (v15 fabf0261, 2026-11-06): the first payment try after the move used
  // to answer 503 until the checkout lapsed. Now it answers once that the table changed; the guest
  // goes back and a second continue opens a payment at the new table (no rescan, no retry loop).
  const { intentCalls } = await checkout(page, {
    channel: "DineIn",
    intents: refused(409, "payment_table_moved"),
  });
  // Checking out again is a new checkout (the server answers a new checkout session for it, made
  // at the table the party sits at now); its payment starts.
  const again = id(20);
  const againView = {
    schemaVersion: 1,
    session: {
      checkoutSessionReference: again,
      cartReference: id(1),
      cartVersion: 3,
      quoteReference: id(6),
      quoteVersion: 1,
      createdAt: new Date().toISOString(),
    },
  };
  let sessions = 0;
  await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
    sessions += 1;
    return sessions === 1 ? route.fallback() : route.fulfill({ status: 201, json: againView });
  });
  await page.route(`**/api/v1/checkout-sessions/${again}`, (route) =>
    route.fulfill({ status: 200, json: againView }),
  );
  const againCalls: unknown[] = [];
  await page.route(`**/api/v1/checkout-sessions/${again}/payment-intents`, (route) => {
    againCalls.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        payment: {
          checkoutSessionReference: again,
          paymentIntentReference: id(21),
          orderReference: id(12),
          creationStatus: "Created",
          total: { amountMinor: "2260", currency: "CAD" },
        },
      },
    });
  });
  await page.route(`**/api/v1/checkout-sessions/${again}/payment-handoff`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, clientSecret: "pi_SyntheticAgain_secret_SyntheticOnly" },
    }),
  );
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Your table was changed" })).toBeVisible();
  // One answer, no automatic retries while the guest reads it.
  await page.waitForTimeout(1500);
  expect(intentCalls).toHaveLength(1);
  await main.getByRole("link", { name: /^Back to (your cart|checkout)$/u }).click();
  await expect(page.getByText("Synthetic noodles").first()).toBeVisible();
  const proceed = page.getByRole("button", { name: /Continue to payment/u });
  await expect(proceed).toBeEnabled();
  await proceed.click();
  await expect(page).toHaveURL(/\/checkout\/payment$/u);
  await expect(page.getByText("Synthetic secure card component")).toBeVisible();
  expect(sessions).toBe(2);
  expect(intentCalls).toHaveLength(1);
  expect(againCalls).toHaveLength(1);
});

test("@production the table move reads in Chinese, with no call for staff and no sideways scroll", async ({
  page,
}) => {
  const { intentCalls } = await checkout(page, {
    channel: "DineIn",
    intents: refused(409, "payment_table_moved"),
  });
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { level: 1, name: "Synthetic Store", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "切换到中文" }).click();
  await page.evaluate(() => {
    history.pushState(null, "", "/checkout");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const proceed = page.getByRole("button", { name: /去付款/u });
  await expect(proceed).toBeEnabled();
  await proceed.click();
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "你们换了桌" })).toBeVisible();
  await expect(main).toContainText("这次没有扣款");
  await expect(main.getByRole("link", { name: /^返回(结账|购物车)$/u })).toBeVisible();
  await expect(main).not.toContainText("请找店员");
  await expect(main).not.toContainText("暂时无法开始付款");
  await expectNoInternalText(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(intentCalls).toHaveLength(1);
});

test("@production a table that turns out to pay at the end goes back to its cart", async ({
  page,
}) => {
  await checkout(page, { channel: "DineIn", intents: refused(409, "payment_pay_later_table") });
  await tapContinue(page);
  await expect(page).toHaveURL(/\/cart$/u);
  await expect(page.getByRole("button", { name: "Place order", exact: true })).toBeVisible();
});

test("@production after a card was offered, last orders never says it wasn't charged", async ({
  page,
  context,
}) => {
  const { intentCalls } = await checkout(page, {
    channel: "Pickup",
    intents: (route, call) =>
      call === 1 ? created(route, call) : refused(409, "payment_store_closed")(route, call),
  });
  let resultReads = 0;
  let answer: "unreadable" | "pending" = "unreadable";
  await page.route(`**/api/v1/checkout-sessions/${session}/payment-result`, (route) => {
    resultReads++;
    return answer === "unreadable"
      ? route.fulfill({ status: 503, json: { schemaVersion: 1, error: { code: "x" } } })
      : route.fulfill({
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 1,
            payment: {
              checkoutSessionReference: session,
              paymentIntentReference: id(11),
              orderReference: id(12),
              status: "Pending",
              total: { amountMinor: "2260", currency: "CAD" },
              payBy: new Date(Date.now() + 600_000).toISOString(),
              failure: null,
            },
          },
        });
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByText("Synthetic secure card component")).toBeVisible();
  await context.setOffline(true);
  // WP-2423 M17: the card may have gone through; the page says not to pay again, offers nothing.
  await expect(
    main.getByRole("heading", { name: "Checking your payment — don’t pay again" }),
  ).toBeVisible();
  await expect(main).not.toContainText("charged");
  await expect(main.getByRole("button", { name: "Continue to payment" })).toHaveCount(0);
  await context.setOffline(false);
  // Back online the result is read by itself; still unreadable, still nothing to pay with.
  await expect.poll(() => resultReads).toBeGreaterThan(0);
  await expect(main.getByRole("button", { name: "Continue to payment" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Check now", exact: true })).toBeEnabled();
  // The payment exists: the result page takes over, which offers that same attempt only.
  answer = "pending";
  await main.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(page).toHaveURL(/\/checkout\/result$/u);
  expect(intentCalls).toHaveLength(1);
});

test("@production WP-2423 M17: a card that went through while the page lost track shows as paid by itself", async ({
  page,
  context,
}) => {
  await checkout(page, { channel: "Pickup", intents: created });
  await page.route(`**/api/v1/checkout-sessions/${session}/payment-result`, (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        payment: {
          checkoutSessionReference: session,
          paymentIntentReference: id(11),
          orderReference: id(12),
          status: "Succeeded",
          total: { amountMinor: "2260", currency: "CAD" },
          payBy: new Date(Date.now() + 600_000).toISOString(),
          failure: null,
        },
      },
    }),
  );
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByText("Synthetic secure card component")).toBeVisible();
  await context.setOffline(true);
  await context.setOffline(false);
  await expect(page).toHaveURL(/\/checkout\/result$/u);
  await expect(page.getByRole("heading", { name: "Payment confirmed", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to payment" })).toHaveCount(0);
  // WP-2423 M17: reconnecting never claims nothing was sent.
  await expect(page.getByText("Nothing was sent", { exact: false })).toHaveCount(0);
  await expectNoInternalText(page);
});

test("@production WP-2423 M19: the payment page says until when to pay, warns in the last minutes, and stops at the end", async ({
  page,
}) => {
  await page.clock.install();
  const now = Date.now();
  // The server's clock: six minutes left.
  const payBy = new Date(now + 6 * 60_000).toISOString();
  await checkout(page, {
    channel: "Pickup",
    intents: (route) =>
      route.fulfill({
        status: 201,
        json: {
          schemaVersion: 1,
          payment: {
            checkoutSessionReference: session,
            paymentIntentReference: id(11),
            orderReference: id(12),
            creationStatus: "Created",
            total: { amountMinor: "2260", currency: "CAD" },
            payBy,
          },
          serverNow: new Date(now).toISOString(),
        },
      }),
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByText("Synthetic secure card component")).toBeVisible();
  await expect(main.getByText(/^Pay by /u)).toBeVisible();
  await expect(main.getByText("About 5 minutes left to pay.", { exact: false })).toHaveCount(0);
  await page.clock.runFor(70_000);
  await expect(main.getByRole("alert")).toContainText("About 5 minutes left to pay.");
  await expect(main).toContainText("this order is cancelled and you won’t be charged");
  await expectNoInternalText(page);
  // At the end the card is no longer offered; the page reads what happened instead.
  await page.clock.runFor(5 * 60_000);
  await expect(main.getByText("Synthetic secure card component")).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Pay securely" })).toHaveCount(0);
});

for (const width of [390, 1024, 1440])
  test(`@production a guest who never paid is told time ran out at the deadline, never that the payment is still being confirmed (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    const now = Date.now();
    const payBy = new Date(now + 60_000).toISOString();
    // The Store cancels the unpaid payment a few seconds after its deadline.
    let cancelled = false;
    const reads: string[] = [];
    await page.route(`**/api/v1/checkout-sessions/${session}/payment-result`, (route) => {
      reads.push(cancelled ? "Failed" : "Pending");
      return route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 1,
          payment: {
            checkoutSessionReference: session,
            paymentIntentReference: id(11),
            orderReference: id(12),
            status: cancelled ? "Failed" : "Pending",
            total: { amountMinor: "2260", currency: "CAD" },
            payBy,
            failure: cancelled ? "NotCompleted" : null,
          },
        },
      });
    });
    await checkout(page, {
      channel: "Pickup",
      intents: (route) =>
        route.fulfill({
          status: 201,
          json: {
            schemaVersion: 1,
            payment: {
              checkoutSessionReference: session,
              paymentIntentReference: id(11),
              orderReference: id(12),
              creationStatus: "Created",
              total: { amountMinor: "2260", currency: "CAD" },
              payBy,
            },
            serverNow: new Date(now).toISOString(),
          },
        }),
    });
    await goToPayment(page);
    const main = page.getByRole("main");
    await expect(main.getByText("Synthetic secure card component")).toBeVisible();
    // The guest never presses Pay. One second past the deadline:
    await page.clock.runFor(61_000);
    await expect(main.getByRole("heading", { name: "Time to pay ran out" })).toBeVisible();
    await expect(main).toContainText("This order is being cancelled and you haven’t been charged.");
    await expect(main.getByText("Synthetic secure card component")).toHaveCount(0);
    await expect(page.getByText("still being confirmed", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Don’t start another payment", { exact: false })).toHaveCount(0);
    await expect(page).toHaveURL(/\/checkout\/payment$/u);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await expectNoInternalText(page);
    await page.screenshot({ path: `test-results/time-up-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(main.getByRole("heading", { name: "付款时间已过" })).toBeVisible();
    await expect(main).toContainText("这笔订单正在取消，你没有被扣款。");
    // Once the Store has cancelled it, the result says so; it never read "still being confirmed".
    cancelled = true;
    await page.clock.runFor(3_100);
    await expect(page).toHaveURL(/\/checkout\/result$/u);
    await expect(page.getByRole("main")).toContainText("这笔付款没有及时完成，已取消，没有扣款。");
    expect(reads[0]).toBe("Pending");
  });

test("@production WP-2423 M19: a payment whose time ran out before a card was offered says so, with a way back", async ({
  page,
}) => {
  await checkout(page, { channel: "Pickup", intents: refused(422, "payment_window_ended") });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Time to pay ran out" })).toBeVisible();
  await expect(main).toContainText("Your order was cancelled and you haven’t been charged.");
  await expect(main.getByRole("link", { name: "Back to menu" })).toBeVisible();
  await expect(main.getByRole("button", { name: "Continue to payment" })).toHaveCount(0);
  await expectNoInternalText(page);
});

test("@production the first card form failing to load says this payment wasn't charged, and tries again", async ({
  page,
}) => {
  let aborted = false;
  await checkout(page, {
    channel: "Pickup",
    intents: created,
    stripe: (route) => {
      if (!aborted) {
        aborted = true;
        return route.abort("failed");
      }
      return route.fulfill({ contentType: "application/javascript", body: syntheticStripe });
    },
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "The secure card form didn’t load" }),
  ).toBeVisible();
  await expect(main).toContainText("This payment hasn’t been charged.");
  await expect(main.getByRole("button", { name: "Pay securely" })).toHaveCount(0);
  await main.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(main.getByText("Synthetic secure card component")).toBeVisible();
  await expect(main.getByRole("button", { name: "Pay securely" })).toBeEnabled();
  await expect(main.getByRole("alert")).toHaveCount(0);
});

test("@production a card form that never answers says so beside it, and a late answer clears that", async ({
  page,
}) => {
  await page.clock.install();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await checkout(page, {
    channel: "Pickup",
    intents: created,
    stripe: async (route) => {
      await held;
      await route.fulfill({ contentType: "application/javascript", body: syntheticStripe });
    },
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByText("Loading secure card form…")).toBeVisible();
  await page.clock.runFor(20_000);
  await expect(
    main.getByRole("heading", { name: "The secure card form didn’t load" }),
  ).toBeVisible();
  await expect(main.getByRole("button", { name: "Pay securely" })).toBeDisabled();
  await expect(main.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  // On packed Wi-Fi the form may still arrive: then the message goes and the form works.
  release();
  await expect(main.getByText("Synthetic secure card component")).toBeVisible();
  await expect(main.getByRole("heading", { name: "The secure card form didn’t load" })).toHaveCount(
    0,
  );
  await expect(main.getByRole("button", { name: "Pay securely" })).toBeEnabled();
});

test("@production a card form still hung after Try again reloads onto the same payment", async ({
  page,
}) => {
  await page.clock.install();
  await checkout(page, {
    channel: "Pickup",
    intents: created,
    // js.stripe.com never answers: the loader keeps its one pending load.
    stripe: () => new Promise<void>(() => undefined),
  });
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByText("Loading secure card form…")).toBeVisible();
  await page.clock.runFor(20_000);
  await expect(
    main.getByRole("heading", { name: "The secure card form didn’t load" }),
  ).toBeVisible();
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => navigations.push(frame.url()));
  await main.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => navigations.length).toBeGreaterThan(0);
});

// v15 b15 (order 12, L14 OSC B): staff cancelled the unpaid round while the guest was on the
// payment page. The card stayed offered, Confirm answered "payment service unavailable" for ~30 s,
// and the page then said the payment "wasn't finished in time". The page now learns the round was
// cancelled by itself and says so plainly: nothing was charged, no card to try again.
test("@production a round the restaurant cancels while its card is offered says so, nothing charged", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await checkout(page, { channel: "DineIn", intents: created });
  let cancelled = false;
  await page.route(`**/api/v1/checkout-sessions/${session}/payment-result`, (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        payment: {
          checkoutSessionReference: session,
          paymentIntentReference: id(11),
          orderReference: id(12),
          status: cancelled ? "Failed" : "Pending",
          total: { amountMinor: "2260", currency: "CAD" },
          payBy: new Date(Date.now() + 600_000).toISOString(),
          failure: cancelled ? "CancelledByStaff" : null,
        },
      },
    }),
  );
  await goToPayment(page);
  const main = page.getByRole("main");
  await expect(main.getByText("Synthetic secure card component")).toBeVisible();
  // Staff choose "Cancel unpaid round" on Orders; the guest touches nothing.
  cancelled = true;
  await expect(page).toHaveURL(/\/checkout\/result$/u, { timeout: 20_000 });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("heading", { name: "Round cancelled", exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "The restaurant cancelled this round before it was paid. Nothing was charged.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Not charged", { exact: true })).toBeVisible();
    await expect(page.getByText("declined", { exact: false })).toHaveCount(0);
    await expect(page.getByText("wasn’t finished in time", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /another card|Try again/u })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/payment-round-cancelled-${width}.png` });
  }
  await expectNoInternalText(page);
});
