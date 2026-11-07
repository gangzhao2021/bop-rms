import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 DEC-DINE-IN-PAY-LATER: at a table that pays once at the end, a round is placed from the
// cart in one tap: no tip, no payment and no review page. The table page then shows it. Item 6: the
// four server steps run behind one button. Synthetic HTTP interception on the production PWA; the
// server's side is the acceptance tests' (dine-in journey, pay-later round).
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => "018f8a00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);

/** A published menu with the cart's line on it at $10.00, as a guest saw it. */
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

interface TableOptions {
  /** No menu to price the lines from: the guest hasn't seen a price. */
  readonly noMenu?: boolean;
  readonly subtotalMinor?: string;
  readonly totalMinor?: string;
  /** What the checkout session answers (default: it opens). */
  readonly session?: (route: Route) => Promise<void> | void;
  /** What the send answers (default: a round is placed). */
  readonly send?: (route: Route, call: number) => Promise<void> | void;
  /** What the details save answers (default: saved). */
  readonly details?: (route: Route) => Promise<void> | void;
  /** What the quote answers (default: priced). */
  readonly quote?: (route: Route, call: number) => Promise<void> | void;
  /** Rounds already on the table when the first round is placed (a charge when it opened). */
  readonly earlierRounds?: readonly unknown[];
  /** The store's documents, for the policy read. */
  readonly documents?: readonly unknown[];
  readonly checkingOut?: boolean;
  /** More dishes in the cart than the one: a long list, with the button far down the page. */
  readonly moreDishes?: number;
  /** The status a placed round is read with (default: sent to the kitchen). */
  readonly roundStatus?: string;
  /** WP-2423 (guest-cart-503): the extra dishes' line marks (e.g. another phone's, not sold now). */
  readonly moreDishWarnings?: readonly string[];
  /** The extra dishes are other dishes (their own sellable), not more lines of the first one. */
  readonly otherDishes?: boolean;
}

interface Table {
  readonly sent: { body: unknown; key: string | undefined }[];
  readonly calls: string[];
  readonly sessionKeys: (string | undefined)[];
  /** The cart is empty: a round was placed, here or by another phone. */
  emptyCart(): void;
  placeRound(): void;
  /** A guest changed the cart: it has this dish on top, at a new version. */
  addDish(name: string): void;
  /** Another guest's quote is attached to the same cart version now. */
  attachQuote(reference: string): void;
  /** Where the placed round is on the next read of the table. */
  moveRound(status: string): void;
}

async function stubTable(
  page: Page,
  sent: { body: unknown; key: string | undefined }[] = [],
  options: TableOptions = {},
): Promise<Table> {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const now = new Date().toISOString();
  let roundSent = false;
  let roundStatus = options.roundStatus ?? "Queued";
  let cartVersion = 3;
  let attachedQuote: string | null = null;
  const dish = (reference: number, name: string, quantity = 2) => ({
    cartItemReference: id(reference),
    sellableReference: id(3),
    displayName: name,
    quantity,
    configuration: [],
    customerNote: null,
    lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
    warnings: [],
  });
  let dishes = [
    dish(2, "Synthetic noodles"),
    ...Array.from({ length: options.moreDishes ?? 0 }, (_, index) => ({
      ...dish(60 + index, `Synthetic dish ${index + 1}`),
      ...(options.otherDishes === true ? { sellableReference: id(160 + index) } : {}),
      warnings: [...(options.moreDishWarnings ?? [])],
    })),
  ];
  const cartView = () => ({
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version: cartVersion,
      orderType: "DineIn",
      serviceMode: "DineIn",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Table Store" },
      lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
      items: dishes,
      quote:
        attachedQuote === null
          ? null
          : {
              quoteReference: attachedQuote,
              quoteVersion: 1,
              cartVersion,
              subtotal: { amountMinor: "2000", currency: "CAD" },
              discount: { amountMinor: "0", currency: "CAD" },
              tax: { amountMinor: "260", currency: "CAD" },
              fee: { amountMinor: "0", currency: "CAD" },
              total: { amountMinor: "2260", currency: "CAD" },
              expiresAt,
              warnings: [],
              blockingReasons: [],
            },
      warnings: [],
    },
  });
  const calls: string[] = [];
  const sessionKeys: (string | undefined)[] = [];
  const subtotal = options.subtotalMinor ?? "2000";
  const total = options.totalMinor ?? "2260";
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ schemaVersion: 1, orderMessages: { sms: false, email: false } }),
    }),
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
  if (options.noMenu !== true)
    await page.route(`**/api/v1/public/stores/${publicStore}/menu**`, (route) =>
      route.fulfill({ status: 200, json: pricedMenu() }),
    );
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) =>
    route.fulfill({ status: 200, json: cartView() }),
  );
  await page.route("**/api/v1/carts/*/items/*", (route) => {
    if (route.request().method() === "DELETE") {
      dishes = dishes.filter((item) => !route.request().url().includes(item.cartItemReference));
      cartVersion += 1;
      return route.fulfill({ status: 200, json: cartView() });
    }
    const change = route.request().postDataJSON() as { quantity: number };
    dishes = dishes.map((item) =>
      route.request().url().includes(item.cartItemReference)
        ? { ...item, quantity: change.quantity }
        : item,
    );
    cartVersion += 1;
    return route.fulfill({ status: 200, json: cartView() });
  });
  await page.route("**/api/v1/dine-in/table-payment", (route) => {
    calls.push("table");
    return route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        payment: {
          tableLabel: "12",
          checkingOut: options.checkingOut === true,
          rounds: [],
          owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
          consistent: true,
          state: "NotPaid",
          attempt: null,
          receipt: null,
        },
      },
    });
  });
  await page.route("**/api/v1/dine-in/staff-call", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        staffCall: { open: null, recentlyClosed: null, nextCallAt: null },
      },
    }),
  );
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, invitation: { canInvite: false } },
    }),
  );
  let quotes = 0;
  await page.route("**/api/v1/carts/*/quote", (route) => {
    calls.push("quote");
    quotes += 1;
    const answer = options.quote?.(route, quotes);
    if (answer !== undefined) return answer;
    return route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        quote: {
          quoteReference: id(6),
          quoteVersion: 1,
          cartVersion,
          currency: "CAD",
          subtotal: { amountMinor: subtotal, currency: "CAD" },
          discount: { amountMinor: "0", currency: "CAD" },
          tax: { amountMinor: "260", currency: "CAD" },
          fee: { amountMinor: "0", currency: "CAD" },
          total: { amountMinor: total, currency: "CAD" },
          expiresAt,
          warnings: [],
          blockingReasons: [],
          priceChange: null,
        },
      },
    });
  });
  await page.route("**/bff/customer/checkout-details/current", (route) => {
    calls.push("details-read");
    return route.fulfill({
      json: {
        schemaVersion: 1,
        checkout: { cartReference: id(1), cartVersion, orderType: "DineIn", details: null },
      },
    });
  });
  await page.route("**/bff/customer/checkout-details/policy", (route) => {
    calls.push("policy");
    return route.fulfill({
      json: {
        schemaVersion: 1,
        policy: {
          cartReference: id(1),
          cartVersion,
          orderType: "DineIn",
          checkedAt: new Date(Date.now() - 1000).toISOString(),
          validUntil: expiresAt,
          documents: options.documents ?? [],
        },
      },
    });
  });
  await page.route("**/bff/customer/checkout-details", async (route) => {
    calls.push("details-save");
    const answered = options.details?.(route);
    if (answered !== undefined) return answered;
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
          cartVersion,
          quoteReference: body.quoteReference,
          quoteVersion: 1,
          orderType: "DineIn",
          receiptChoice: "InSession",
          recordedAt: new Date().toISOString(),
        },
      },
    });
  });
  await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
    calls.push("session");
    sessionKeys.push(route.request().headers()["idempotency-key"]);
    const answered = options.session?.(route);
    if (answered !== undefined) return answered;
    const body = route.request().postDataJSON() as { quoteReference: string };
    return route.fulfill({
      status: 200,
      json: {
        schemaVersion: 1,
        session: {
          checkoutSessionReference: id(10),
          cartReference: id(1),
          cartVersion,
          quoteReference: body.quoteReference,
          quoteVersion: 1,
          createdAt: now,
        },
      },
    });
  });
  const placed = (status: number) => ({
    status,
    json: {
      schemaVersion: 1,
      round: {
        checkoutSessionReference: id(10),
        orderReference: id(20),
        status: status === 201 ? "Sent" : "AlreadySent",
        total: { amountMinor: total, currency: "CAD" },
      },
    },
  });
  await page.route("**/api/v1/checkout-sessions/*/payment-intents", async (route) => {
    const request = route.request();
    calls.push("send");
    sent.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
    const answered = options.send?.(route, sent.length);
    if (answered !== undefined) return answered;
    roundSent = true;
    dishes = [];
    cartVersion += 1;
    await route.fulfill(placed(201));
  });
  const earlier = options.earlierRounds ?? [];
  await page.route("**/api/v1/dine-in/session**", (route) => {
    const rounds = [
      ...earlier,
      ...(roundSent
        ? [
            {
              roundNumber: earlier.length + 1,
              orderedBy: "You",
              submittedAt: now,
              status: roundStatus,
              payment: "OnTableBill",
              cancelsAt: null,
              storeCancellationReason: null,
              items: [
                {
                  displayName: "Synthetic noodles",
                  quantity: 2,
                  servedQuantity: 0,
                  cancelled: false,
                  lineTotal: { amountMinor: "2260", currencyCode: "CAD" },
                },
              ],
              itemsTotal: { amountMinor: "2260", currencyCode: "CAD" },
            },
          ]
        : []),
    ];
    return route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        session: {
          tableLabel: "12",
          orderNumber: rounds.length > 0 ? "1042" : null,
          checkedAt: new Date().toISOString(),
          paymentTiming: "PayLater",
          rounds,
          summary:
            rounds.length > 0
              ? {
                  paid: { amountMinor: "0", currencyCode: "CAD" },
                  refunded: { amountMinor: "0", currencyCode: "CAD" },
                  refundPending: { amountMinor: "0", currencyCode: "CAD" },
                  due: { amountMinor: "2260", currencyCode: "CAD" },
                }
              : null,
        },
      },
    });
  });
  return {
    sent,
    calls,
    sessionKeys,
    emptyCart() {
      dishes = [];
      cartVersion += 1;
    },
    placeRound() {
      roundSent = true;
      dishes = [];
      cartVersion += 1;
    },
    addDish(name) {
      dishes = [dish(70 + dishes.length, name, 1), ...dishes];
      cartVersion += 1;
      attachedQuote = null;
    },
    attachQuote(reference) {
      attachedQuote = reference;
    },
    moveRound(status) {
      roundStatus = status;
    },
  };
}

/** Enter the table and open the cart, as a guest does from the menu. */
async function openCart(page: Page) {
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { level: 1, name: "Synthetic Table Store", exact: true }),
  ).toBeVisible();
  await goTo(page, "/cart");
}

/** The address changes without a tap on the page: the browser's back and forward do this too. */
const goTo = (page: Page, path: string) =>
  page.evaluate((target) => {
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);

const roundPlacedAnswer = (status: "Sent" | "AlreadySent") => ({
  status: status === "Sent" ? 201 : 200,
  json: {
    schemaVersion: 1,
    round: {
      checkoutSessionReference: id(10),
      orderReference: id(20),
      status,
      total: { amountMinor: "2260", currency: "CAD" },
    },
  },
});

const placeOrder = (page: Page) => page.getByRole("button", { name: "Place order", exact: true });
const roundReference = /^[0-9a-f-]{36}$/u;

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Pay-later table, placing a round " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("places a round from the cart in one tap", async ({ page }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const table = await stubTable(page);
      const pages: string[] = [];
      page.on("framenavigated", (frame) => pages.push(new URL(frame.url()).pathname));
      await openCart(page);
      const button = placeOrder(page);
      await expect(button).toBeEnabled();
      const main = page.getByRole("main");
      await expect(main).toContainText("Nothing is charged now.");
      await expect(main).toContainText("Allergies? Ask a staff member before you order.");
      await expect(main).toContainText("Tax is added to your table’s bill.");
      // Nothing about paying or a price lock on the way.
      await expect(main.getByRole("heading", { name: "Tip", exact: true })).toHaveCount(0);
      await expect(main).not.toContainText("Checkout");
      await expect(main).not.toContainText("Prices held for");
      await expectNoInternalText(page);
      // The notes qualify the button: they read with it at every width, not across the page.
      const widths = screen.touch ? [screen.width] : [1024, screen.width];
      for (const width of widths) {
        await page.setViewportSize({ width, height: screen.height });
        const note = main.getByText("Nothing is charged now.");
        expect((await button.boundingBox())?.x).toBe((await note.boundingBox())?.x);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await page.screenshot({
          path: `test-results/cart-place-order-${width}.png`,
          fullPage: true,
        });
      }
      await button.click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      await expect(main.getByText("Save details", { exact: true })).toHaveCount(0);
      await expect(main.getByText("Reload checkout details", { exact: true })).toHaveCount(0);
      expect(pages).not.toContain("/checkout");
      // The table page is the only proof the tap worked: it says so.
      await expect(main.getByRole("status").filter({ hasText: "Order placed." })).toBeVisible();
      await expect(main).not.toContainText("sent to the kitchen");
      await expect(page.getByText("On the table's bill").first()).toBeVisible();
      await expect(page.getByText("To pay at the end")).toBeVisible();
      expect(table.sent).toHaveLength(1);
      expect(table.sent[0]?.body).toEqual({ sendToKitchen: true });
      expect(table.sent[0]?.key).toMatch(roundReference);
      // Read together, then each step once, in order; never a policy read a slow phone clock fails.
      expect(table.calls.filter((call) => call !== "table" && call !== "details-read")).toEqual([
        "quote",
        "details-save",
        "session",
        "send",
      ]);
      expect(table.calls).not.toContain("policy");
      expect(table.calls.filter((call) => call === "details-read")).toHaveLength(1);
      expect(failures).toEqual([]);
    });

    test("a phone clock behind the server still places a round", async ({ page }) => {
      const table = await stubTable(page);
      await page.clock.install({ time: new Date(Date.now() - 3_600_000) });
      await openCart(page);
      await placeOrder(page).click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      expect(table.sent).toHaveLength(1);
    });
  });
}

test.describe("@production Pay-later table, the round just placed", () => {
  test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });

  const inView = (page: Page, locator: Locator) =>
    expect
      .poll(async () => {
        const box = await locator.boundingBox();
        const height = page.viewportSize()?.height ?? 0;
        return box !== null && box.y >= 0 && box.y + box.height <= height;
      })
      .toBe(true);

  const chargeRound = {
    roundNumber: 1,
    orderedBy: "Staff",
    tea: true,
    charge: true,
    submittedAt: new Date().toISOString(),
    status: "Queued",
    payment: "OnTableBill",
    cancelsAt: null,
    storeCancellationReason: null,
    items: [
      {
        displayName: "Sauce bar",
        quantity: 4,
        servedQuantity: 0,
        cancelled: false,
        lineTotal: { amountMinor: "800", currencyCode: "CAD" },
      },
    ],
    itemsTotal: { amountMinor: "800", currencyCode: "CAD" },
  };

  for (const [name, earlierRounds] of [
    ["first round", []],
    ["with a charge from when the table opened", [chargeRound]],
  ] as const)
    test(`the line and the new round are on screen without scrolling: ${name}`, async ({
      page,
    }) => {
      await stubTable(page, [], { earlierRounds });
      await openCart(page);
      await placeOrder(page).click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      const main = page.getByRole("main");
      await inView(page, main.getByRole("status").filter({ hasText: "Order placed." }));
      const number = earlierRounds.length + 1;
      await inView(page, main.getByRole("heading", { name: new RegExp(`^Round ${number} `, "u") }));
      await page.screenshot({
        path: `test-results/round-placed-${earlierRounds.length}-390.png`,
      });
    });

  test("a round waiting for staff says so", async ({ page }) => {
    await stubTable(page, [], {
      send: (route) =>
        route.fulfill({
          status: 202,
          json: {
            schemaVersion: 1,
            round: {
              checkoutSessionReference: id(10),
              orderReference: id(20),
              status: "Held",
              waitingReason: "FirstOrder",
              total: { amountMinor: "2260", currency: "CAD" },
            },
          },
        }),
    });
    await openCart(page);
    await placeOrder(page).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    await expect(
      page.getByRole("status").filter({ hasText: "Order placed. Staff confirm it first." }),
    ).toBeVisible();
  });

  test("a total that went up stops and asks once", async ({ page }) => {
    const table = await stubTable(page, [], { subtotalMinor: "2200", totalMinor: "2486" });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(
      main.getByText("The price changed since you added this. It now comes to $24.86 with tax."),
    ).toBeVisible();
    // Nothing was saved or sent yet.
    expect(table.calls).not.toContain("details-save");
    expect(table.sent).toEqual([]);
    await page.getByRole("button", { name: "Place order · $24.86", exact: true }).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    expect(table.sent).toHaveLength(1);
    expect(table.calls.filter((call) => call === "quote")).toHaveLength(1);
  });

  test("with no price shown yet, the guest sees the total once before it's placed", async ({
    page,
  }) => {
    const table = await stubTable(page, [], { noMenu: true });
    await openCart(page);
    const main = page.getByRole("main");
    await expect(main).toContainText("Prices and tax are on your table’s bill.");
    await placeOrder(page).click();
    await expect(main.getByText("This order comes to $22.60 with tax.")).toBeVisible();
    expect(table.sent).toEqual([]);
    await page.getByRole("button", { name: "Place order · $22.60", exact: true }).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    expect(table.sent).toHaveLength(1);
  });

  test("a dish that ran out is named and the cart stays", async ({ page }) => {
    const table = await stubTable(page, [], {
      session: (route) =>
        route.fulfill({
          status: 409,
          json: {
            schemaVersion: 1,
            error: {
              code: "checkout_session_item_short",
              messageKey: "customer.checkout.item_short",
              line: { cartItemReference: id(2), available: 1, sharedStock: false },
            },
          },
        }),
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("alert")).toContainText("Synthetic noodles");
    await expect(main.getByRole("alert")).toContainText("Only 1");
    await expect(main.getByRole("article", { name: "Synthetic noodles" })).toBeVisible();
    await expect(page).toHaveURL(/\/cart$/u);
    expect(table.sent).toEqual([]);
    await expectNoInternalText(page);
  });

  test("a table that started checking out says so, and places nothing", async ({ page }) => {
    const table = await stubTable(page, [], { checkingOut: true });
    await openCart(page);
    await placeOrder(page).click();
    await expect(
      page.getByText("New dishes can’t be sent while the bill is being settled."),
    ).toBeVisible();
    expect(table.calls).not.toContain("quote");
    expect(table.sent).toEqual([]);
  });

  test("a Store with documents opens the page with the agree box and no receipt block", async ({
    page,
  }) => {
    const table = await stubTable(page, [], {
      details: (route) =>
        route.fulfill({
          status: 422,
          json: {
            schemaVersion: 1,
            error: {
              code: "details_policy_changed",
              messageKey: "customer.checkout.policy_changed",
            },
          },
        }),
      documents: [
        {
          documentReference: id(30),
          documentVersion: 1,
          documentDigest: `sha256:${"a".repeat(64)}`,
          purposeCode: "TERMS",
          title: "Synthetic house rules",
          bodyText: "Synthetic rule text.",
        },
      ],
    });
    await openCart(page);
    await placeOrder(page).click();
    await expect(page).toHaveURL(/\/checkout$/u);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Place order", exact: true })).toBeVisible();
    await expect(main.getByText("Synthetic house rules")).toBeVisible();
    await expect(main.getByLabel("I’ve read and agree to the policies above")).toBeVisible();
    await expect(main.getByText("Receipt", { exact: true })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Save details" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Reload checkout details" })).toHaveCount(0);
    await expect(main.getByRole("list", { name: "Checkout progress" })).toHaveCount(0);
    await expect(main).not.toContainText("Prices held for");
    expect(table.sent).toEqual([]);
  });

  test("a lost answer tried again places one round", async ({ page }) => {
    const table = await stubTable(page, [], {
      send: (route, call) => (call === 1 ? route.abort("internetdisconnected") : undefined),
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("alert").filter({ hasText: "We couldn’t confirm" })).toContainText(
      "Try again — it is never placed twice. You can also tell a staff member what you’d like.",
    );
    // Help is one tap away, and the cart holds still until this is settled.
    await expect(main.getByRole("heading", { name: "Need a staff member?" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Remove" })).toBeDisabled();
    await main.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    expect(table.sent).toHaveLength(2);
    expect(table.sent[1]?.key).toBe(table.sent[0]?.key);
    expect(table.calls.filter((call) => call === "session")).toHaveLength(1);
  });

  test("the server placed it but the answer was lost: trying again finds the same round", async ({
    page,
  }) => {
    const table: Table = await stubTable(page, [], {
      send: (route, call) => {
        if (call === 1) {
          // The order transaction committed and emptied the cart; the answer never arrived.
          table.placeRound();
          return route.abort("internetdisconnected");
        }
        return route.fulfill({
          status: 200,
          json: {
            schemaVersion: 1,
            round: {
              checkoutSessionReference: id(10),
              orderReference: id(20),
              status: "AlreadySent",
              total: { amountMinor: "2260", currency: "CAD" },
            },
          },
        });
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    const tryAgain = main.getByRole("button", { name: "Try again", exact: true });
    await expect(tryAgain).toBeVisible();
    // The guest refreshes the cart: it reads empty, and the way to finish is still on top.
    await goTo(page, "/menu");
    await goTo(page, "/cart");
    await expect(main.getByText("Your cart is empty")).toBeVisible();
    await expect(tryAgain).toBeVisible();
    await tryAgain.click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    expect(table.sent).toHaveLength(2);
    expect(table.sent[1]?.key).toBe(table.sent[0]?.key);
    await expect(main.getByRole("heading", { name: /^Round 1 / })).toHaveCount(1);
    await expect(main.getByRole("heading", { name: /^Round 2 / })).toHaveCount(0);
  });

  test("offline during a send: back online, only a tap asks again", async ({ page, context }) => {
    const table = await stubTable(page, [], {
      send: (route, call) =>
        call === 1
          ? context.setOffline(true).then(() => route.abort("internetdisconnected"))
          : undefined,
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    const tryAgain = main.getByRole("button", { name: "Try again", exact: true });
    await expect(tryAgain).toBeDisabled();
    await context.setOffline(false);
    await expect(tryAgain).toBeEnabled();
    // Reconnecting asks nothing by itself.
    expect(table.sent).toHaveLength(1);
    await tryAgain.click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    expect(table.sent).toHaveLength(2);
    expect(table.sent[1]?.key).toBe(table.sent[0]?.key);
  });

  test("a second phone tapping after the first sent reaches the table, with no second round", async ({
    page,
  }) => {
    // This phone still shows the dishes; another phone just placed them.
    const table: Table = await stubTable(page, [], {
      quote: (route, call) => {
        if (call !== 1) return undefined;
        table.placeRound();
        return route.fulfill({
          status: 409,
          json: {
            schemaVersion: 1,
            error: {
              code: "quote_version_conflict",
              messageKey: "customer.quote.version_conflict",
            },
          },
        });
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "Someone at your table just placed this order." }),
    ).toBeVisible();
    await expect(main.getByText("Your cart is empty")).toHaveCount(0);
    await expect(main.getByRole("link", { name: "Browse menu" })).toBeVisible();
    await main.getByRole("link", { name: "See your table" }).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    await expect(main.getByRole("heading", { name: /^Round 1 / })).toHaveCount(1);
    expect(table.sent).toEqual([]);
  });

  test("while it's on its way the cart holds still", async ({ page }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const table: Table = await stubTable(page, [], {
      send: async (route) => {
        await held;
        table.placeRound();
        await route.fulfill(roundPlacedAnswer("Sent"));
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("button", { name: "Placing your order…" })).toBeDisabled();
    await expect(main.getByRole("button", { name: "Remove" })).toBeDisabled();
    await expect(main.getByRole("link", { name: "Continue shopping" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // Its answer is only said on this page, so the journey bar holds still too.
    const journey = page.getByRole("navigation", { name: "Customer journey" });
    for (const name of ["Menu", "Your table"])
      await expect(journey.getByRole("link", { name })).toHaveAttribute("aria-disabled", "true");
    await journey.getByRole("link", { name: "Menu" }).click({ force: true });
    await expect(page).toHaveURL(/\/cart$/u);
    release();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    await expect(journey.getByRole("link", { name: "Menu" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  // The server's side of these is the checkout-moved-on acceptance test.
  const movedOn = (route: Route) =>
    route.fulfill({
      status: 409,
      json: {
        schemaVersion: 1,
        error: {
          code: "checkout_session_intent_conflict",
          messageKey: "customer.checkoutSession.intent_conflict",
        },
      },
    });

  test("a cart that moved on says so at once, and the next tap places it as it is", async ({
    page,
  }) => {
    let refused = false;
    const table: Table = await stubTable(page, [], {
      session: (route) => {
        if (refused) return undefined;
        refused = true;
        // Another guest added a dish just after this phone's quote.
        table.addDish("Mom's dumplings");
        return movedOn(route);
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("alert")).toContainText(
      "Your table’s cart changed, so nothing was placed yet. Check it, then tap Place order.",
    );
    await expect(main.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
    await expect(main.getByRole("article", { name: "Mom's dumplings" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Remove" }).first()).toBeEnabled();
    expect(table.sent).toEqual([]);
    await placeOrder(page).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    expect(table.sent).toHaveLength(1);
    expect(table.sessionKeys[1]).not.toBe(table.sessionKeys[0]);
  });

  test("an answer lost before the send says nothing was placed and leaves the cart free", async ({
    page,
  }) => {
    let lost = false;
    const table = await stubTable(page, [], {
      session: (route) => {
        if (lost) return undefined;
        lost = true;
        return route.abort("internetdisconnected");
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    const panel = main.getByRole("alert").filter({ hasText: "We couldn’t place your order" });
    await expect(panel).toContainText("nothing was sent");
    await expect(main).not.toContainText("We couldn’t confirm");
    await expect(main.getByRole("heading", { name: "Need a staff member?" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Remove" })).toBeEnabled();
    await expect(placeOrder(page)).toBeEnabled();
    await expect(
      page.getByRole("navigation", { name: "Customer journey" }).getByRole("link", {
        name: "Menu",
      }),
    ).not.toHaveAttribute("aria-disabled", "true");
    // Trying again finds the same checkout: same key, nothing else repeated.
    await panel.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    expect(table.sessionKeys).toHaveLength(2);
    expect(table.sessionKeys[1]).toBe(table.sessionKeys[0]);
    expect(table.calls.filter((call) => call === "quote")).toHaveLength(1);
    expect(table.sent).toHaveLength(1);
  });

  test("a price read that keeps failing never locks the cart, and leaving forgets it", async ({
    page,
  }) => {
    const table = await stubTable(page, [], {
      quote: (route) =>
        route.fulfill({
          status: 503,
          json: {
            schemaVersion: 1,
            error: { code: "quote_service_unavailable", messageKey: "customer.quote.unavailable" },
          },
        }),
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("alert")).toContainText("We couldn’t place your order");
    // The dish that makes pricing fail can always be taken out.
    await expect(main.getByRole("button", { name: "Remove" })).toBeEnabled();
    await goTo(page, "/menu");
    await goTo(page, "/cart");
    await expect(main.getByRole("article", { name: "Synthetic noodles" })).toBeVisible();
    await expect(main.getByRole("alert")).toHaveCount(0);
    await expect(placeOrder(page)).toBeEnabled();
    expect(table.sent).toEqual([]);
  });

  test("a lost checkout whose cart moved on is no longer a retry: another guest's dish", async ({
    page,
  }) => {
    const table: Table = await stubTable(page, [], {
      session: (route) => {
        table.addDish("Mom's dumplings");
        return route.abort("internetdisconnected");
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("alert")).toContainText(
      "Your table’s cart changed, so nothing was placed yet. Check it, then tap Place order.",
    );
    await expect(main).not.toContainText("We couldn’t");
    await expect(main.getByRole("article", { name: "Mom's dumplings" })).toBeVisible();
    await expect(placeOrder(page)).toBeEnabled();
    expect(table.sessionKeys).toHaveLength(1);
  });

  test("a lost checkout whose cart moved on is no longer a retry: another guest's quote", async ({
    page,
  }) => {
    const table: Table = await stubTable(page, [], {
      session: (route) => {
        table.attachQuote(id(66));
        return route.abort("internetdisconnected");
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("alert")).toContainText(
      "Your table’s cart changed, so nothing was placed yet. Check it, then tap Place order.",
    );
    await expect(main).not.toContainText("We couldn’t");
    expect(table.sessionKeys).toHaveLength(1);
  });

  test("a lost checkout when someone else placed the cart says so, never 'may have been placed'", async ({
    page,
  }) => {
    const table: Table = await stubTable(page, [], {
      session: (route) => {
        table.placeRound();
        return route.abort("internetdisconnected");
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "Someone at your table just placed this order." }),
    ).toBeVisible();
    await expect(main).not.toContainText("We couldn’t");
    await expect(main.getByRole("link", { name: "See your table" })).toBeVisible();
    expect(table.sent).toEqual([]);
  });

  test("a stop ends when the cart changes: the old total isn't left beside it", async ({
    page,
  }) => {
    const table = await stubTable(page, [], { noMenu: true });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("alert")).toContainText("This order comes to $22.60 with tax.");
    const withTotal = page.getByRole("button", { name: "Place order · $22.60", exact: true });
    await expect(withTotal).toBeVisible();
    await expect.poll(() => table.calls.filter((call) => call === "quote").length).toBe(1);
    await main.getByRole("button", { name: "Increase Synthetic noodles quantity" }).click();
    await expect(main.getByRole("alert")).toHaveCount(0);
    await expect(withTotal).toHaveCount(0);
    await expect(placeOrder(page)).toBeEnabled();
    expect(table.sent).toEqual([]);
    // The next tap asks again about what the cart comes to now, with nothing saved before it.
    await placeOrder(page).click();
    await expect(main.getByRole("alert")).toContainText("This order comes to");
    expect(table.calls.filter((call) => call === "quote")).toHaveLength(2);
    expect(table.calls).not.toContain("details-save");
  });

  test("a stop stays in view at the bottom of a long cart", async ({ page }) => {
    for (const [name, options, said] of [
      [
        "sold out",
        {
          session: (route: Route) =>
            route.fulfill({
              status: 409,
              json: {
                schemaVersion: 1,
                error: {
                  code: "checkout_session_item_short",
                  messageKey: "customer.checkout.item_short",
                  line: { cartItemReference: id(2), available: 1, sharedStock: false },
                },
              },
            }),
        },
        "Only 1",
      ],
      ["total", { subtotalMinor: "16000", totalMinor: "18080" }, "$180.80"],
    ] as const) {
      await page.unrouteAll({ behavior: "wait" });
      await routeStorefrontReads(page.context());
      await stubTable(page, [], { ...options, moreDishes: 6 });
      // Each read takes a moment, as it does on a phone: nothing may jump meanwhile.
      await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fallback();
      });
      await openCart(page);
      const button = placeOrder(page);
      await button.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => window.scrollY);
      expect(before, name).toBeGreaterThan(300);
      await button.click();
      const main = page.getByRole("main");
      const alert = main.getByRole("alert");
      await expect(alert, name).toContainText(said);
      // Give the read after the stop time to finish, then check nothing threw the guest back.
      await page.waitForTimeout(600);
      expect(await page.evaluate(() => window.scrollY), name).toBeGreaterThan(300);
      await inView(page, alert);
      await inView(page, main.locator(".cart-checkout-link"));
      await page.screenshot({ path: `test-results/cart-stop-${name.replace(" ", "-")}-390.png` });
    }
  });

  test("a lost answer is said in view, above a long cart", async ({ page }) => {
    await stubTable(page, [], {
      moreDishes: 6,
      send: (route) => route.abort("internetdisconnected"),
    });
    await openCart(page);
    const button = placeOrder(page);
    await button.scrollIntoViewIfNeeded();
    await button.click();
    const main = page.getByRole("main");
    await inView(page, main.getByRole("alert").filter({ hasText: "We couldn’t confirm" }));
  });

  test("a send that finished after the guest left never claims what's in the cart now", async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let answered = false;
    const table: Table = await stubTable(page, [], {
      send: async (route) => {
        await held;
        table.placeRound();
        await route.fulfill(roundPlacedAnswer("Sent"));
        answered = true;
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    await expect.poll(() => table.sent.length).toBe(1);
    // The browser's back button during the send: on to the menu, one more dish.
    await goTo(page, "/menu");
    release();
    await expect.poll(() => answered).toBe(true);
    table.addDish("Added later");
    await goTo(page, "/cart");
    const main = page.getByRole("main");
    await expect(main.getByRole("article", { name: "Added later" })).toBeVisible();
    await expect(page).toHaveURL(/\/cart$/u);
    const note = main.getByRole("status").filter({ hasText: "Your last order was placed." });
    await expect(note).toContainText("still in your cart");
    await expect(note.getByRole("link", { name: "See your table" })).toBeVisible();
    await expect(main.getByText("Order placed.", { exact: true })).toHaveCount(0);
    // Its own tap is about what's left, and the note about the last one goes. The stub's quote
    // answers more than this one dish, so it asks first; that's the proof it's a new order.
    await placeOrder(page).click();
    await expect(note).toHaveCount(0);
    await expect(main.getByRole("alert")).toContainText("$22.60");
    expect(table.sent).toHaveLength(1);
  });

  test("Try again finishing an older round doesn't say the dishes added since were placed", async ({
    page,
  }) => {
    const table: Table = await stubTable(page, [], {
      send: (route, call) => {
        if (call !== 1) return route.fulfill(roundPlacedAnswer("AlreadySent"));
        table.placeRound();
        return route.abort("internetdisconnected");
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    const main = page.getByRole("main");
    const tryAgain = main.getByRole("button", { name: "Try again", exact: true });
    await expect(tryAgain).toBeVisible();
    // The guest checks the table and adds a dish before they come back to the panel.
    await goTo(page, "/menu");
    table.addDish("Added later");
    await goTo(page, "/cart");
    await expect(main.getByRole("article", { name: "Added later" })).toBeVisible();
    await tryAgain.click();
    const note = main.getByRole("status").filter({ hasText: "Your last order was placed." });
    await expect(note).toContainText("still in your cart");
    await expect(page).toHaveURL(/\/cart$/u);
    await expect(main.getByRole("article", { name: "Added later" })).toBeVisible();
    expect(table.sent).toHaveLength(2);
    expect(table.sent[1]?.key).toBe(table.sent[0]?.key);
  });

  test("the line about a round placed lasts until that round moves on", async ({ page }) => {
    const table = await stubTable(page);
    await openCart(page);
    await placeOrder(page).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    const main = page.getByRole("main");
    const line = main.getByRole("status").filter({ hasText: "Order placed." });
    await expect(line).toBeVisible();
    const refresh = main.getByRole("button", { name: "Refresh now" });
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await expect(line).toBeVisible();
    table.moveRound("Preparing");
    await refresh.click();
    await expect(line).toHaveCount(0);
    await expect(main.getByText("Being prepared", { exact: true })).toBeVisible();
  });

  test("a round waiting for staff stops saying so once staff confirm it", async ({ page }) => {
    const table = await stubTable(page, [], {
      roundStatus: "WaitingForStaff",
      send: (route) => {
        table.placeRound();
        return route.fulfill({
          status: 202,
          json: {
            schemaVersion: 1,
            round: {
              checkoutSessionReference: id(10),
              orderReference: id(20),
              status: "Held",
              waitingReason: "FirstOrder",
              total: { amountMinor: "2260", currency: "CAD" },
            },
          },
        });
      },
    });
    await openCart(page);
    await placeOrder(page).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    const main = page.getByRole("main");
    const line = main.getByRole("status").filter({ hasText: "Staff confirm it first." });
    await expect(line).toBeVisible();
    const refresh = main.getByRole("button", { name: "Refresh now" });
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await expect(line).toBeVisible();
    table.moveRound("Queued");
    await refresh.click();
    await expect(line).toHaveCount(0);
    await expect(main.getByText("Sent to the kitchen", { exact: true })).toBeVisible();
  });

  test("in Chinese: one name for the table on these screens", async ({ page }) => {
    const table: Table = await stubTable(page, [], {
      quote: (route, call) => {
        if (call !== 1) return undefined;
        table.placeRound();
        return route.fulfill({
          status: 409,
          json: {
            schemaVersion: 1,
            error: {
              code: "quote_version_conflict",
              messageKey: "customer.quote.version_conflict",
            },
          },
        });
      },
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await page.getByRole("button", { name: "切换到中文" }).click();
    await goTo(page, "/cart");
    await page.getByRole("button", { name: "下单", exact: true }).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "同桌刚刚下单了这些菜。" })).toBeVisible();
    await expect(main.getByRole("link", { name: "查看本桌", exact: true })).toBeVisible();
    await expect(main).not.toContainText("桌位");
  });

  test("the button waits a moment for prices, so an ordinary guest needs one tap", async ({
    page,
  }) => {
    const table = await stubTable(page);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/v1/public/stores/${publicStore}/menu**`, async (route) => {
      await held;
      await route.fulfill({ status: 200, json: pricedMenu() });
    });
    await openCart(page);
    await expect(placeOrder(page)).toBeDisabled();
    release();
    await expect(placeOrder(page)).toBeEnabled();
    await placeOrder(page).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    expect(table.sent).toHaveLength(1);
  });

  test("a menu that doesn't answer doesn't hold the guest up for long", async ({ page }) => {
    await stubTable(page);
    await page.route(
      `**/api/v1/public/stores/${publicStore}/menu**`,
      () => new Promise<void>(() => undefined),
    );
    await openCart(page);
    // After two seconds it asks once with the total instead of waiting.
    await expect(placeOrder(page)).toBeEnabled({ timeout: 4_000 });
  });

  test("a table that pays first keeps the review page", async ({ page }) => {
    await stubTable(page);
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
            paymentTiming: "PayFirst",
            rounds: [],
            summary: null,
          },
        },
      }),
    );
    await openCart(page);
    await expect(page.getByRole("link", { name: "Checkout", exact: true })).toBeVisible();
    await expect(placeOrder(page)).toHaveCount(0);
  });
});

/**
 * v15 2026-10-30: the moved party's phone, in the order things happen. It joins the table (scans
 * T6's code), sends a round, staff move the party to T7, and the guest reloads the same table page:
 * it says the table moved (not "join your table first"); scanning T7's code joins again and the
 * round is there. Synthetic HTTP standing in for the server, which the database acceptance test
 * proves (the restore of a moved phone's visit says where the party sits, nothing else).
 */
test.describe("@production a moved party's phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  test("reloads its table page after the move and joins the new table again", async ({ page }) => {
    const failures: string[] = [];
    page.on("pageerror", () => failures.push("page error"));
    const sent: { body: unknown; key: string | undefined }[] = [];
    await stubTable(page, sent);
    // The server's side of the story: staff moved the party; the phone joined the new table.
    const table = { moved: false, rejoined: false };
    const movedAway = () => table.moved && !table.rejoined;
    const ok = (route: import("@playwright/test").Route, json: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { operationReference: route.request().headers()["idempotency-key"], ...json },
      });
    // Restoring the visit on a reload (the page keeps its token in memory only).
    await page.route("**/api/v1/customer/session/csrf", (route) =>
      movedAway()
        ? route.fulfill({
            status: 200,
            headers: { "cache-control": "no-store" },
            json: { schemaVersion: 1, movedTable: { tableLabel: "T7" } },
          })
        : route.fulfill({ status: 204, headers: { "cache-control": "no-store" } }),
    );
    await page.route("**/bff/customer/dining/qr-join", (route) => {
      table.rejoined = table.moved;
      return ok(route, { status: "Joined", admissionReference: id(30) });
    });
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    await page.route("**/bff/customer/dining-binding/prepare", (route) =>
      ok(route, {
        status: "Prepared",
        candidateCsrfToken: "n".repeat(43),
        recoveryProof: "r".repeat(43),
        expiresAt,
      }),
    );
    await page.route("**/bff/customer/dining-binding/activate", (route) =>
      ok(route, { status: "Activated", csrfToken: "n".repeat(43) }),
    );

    // Joins at T6 and sends a round.
    await page.goto("/#qr=aaa.bbb.ccc");
    await page.getByRole("button", { name: "Join this table", exact: true }).click();
    await expect(page).toHaveURL(/\/menu$/u);
    await page.evaluate(() => {
      history.pushState(null, "", "/checkout");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByRole("button", { name: /Place order · \$22\.60/u }).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    await expect(page.getByText("On the table's bill").first()).toBeVisible();

    // Staff move the party to T7; the guest reloads the same page.
    table.moved = true;
    await page.reload();
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Your table moved to table T7" })).toBeVisible();
    await expect(main).toContainText("Scan the code on table T7");
    await expect(main).not.toContainText("Join your table first");
    await expectNoInternalText(page);

    // Scans T7's code and joins again: the round is on the table page.
    await page.goto("/#qr=ddd.eee.fff");
    await page.getByRole("button", { name: "Join this table", exact: true }).click();
    await expect(page).toHaveURL(/\/menu$/u);
    expect(table.rejoined).toBe(true);
    await page.evaluate(() => {
      history.pushState(null, "", "/dine-in/session");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByText("On the table's bill").first()).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("Your table moved");
    expect(sent).toHaveLength(1);
    expect(failures).toEqual([]);
  });
});

/**
 * WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): the merged party's phone, in the order things happen. It joins the table (scans
 * T6's code), sends a round, staff merge its table into T7, and the guest reloads the same table page:
 * it says the table was merged into T7; scanning T7's code joins again and the round is on T7's bill. Synthetic HTTP standing in for the server, which the database acceptance test
 * proves (the restore of a moved phone's visit says where the party sits, nothing else).
 */
test.describe("@production a merged party's phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  test("reloads its table page after the merge and joins the other table", async ({ page }) => {
    const failures: string[] = [];
    page.on("pageerror", () => failures.push("page error"));
    const sent: { body: unknown; key: string | undefined }[] = [];
    await stubTable(page, sent);
    // The server's side of the story: staff moved the party; the phone joined the new table.
    const table = { moved: false, rejoined: false };
    const movedAway = () => table.moved && !table.rejoined;
    const ok = (route: import("@playwright/test").Route, json: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { operationReference: route.request().headers()["idempotency-key"], ...json },
      });
    // Restoring the visit on a reload (the page keeps its token in memory only).
    await page.route("**/api/v1/customer/session/csrf", (route) =>
      movedAway()
        ? route.fulfill({
            status: 200,
            headers: { "cache-control": "no-store" },
            json: { schemaVersion: 1, movedTable: { tableLabel: "T7", merged: true } },
          })
        : route.fulfill({ status: 204, headers: { "cache-control": "no-store" } }),
    );
    await page.route("**/bff/customer/dining/qr-join", (route) => {
      table.rejoined = table.moved;
      return ok(route, { status: "Joined", admissionReference: id(30) });
    });
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    await page.route("**/bff/customer/dining-binding/prepare", (route) =>
      ok(route, {
        status: "Prepared",
        candidateCsrfToken: "n".repeat(43),
        recoveryProof: "r".repeat(43),
        expiresAt,
      }),
    );
    await page.route("**/bff/customer/dining-binding/activate", (route) =>
      ok(route, { status: "Activated", csrfToken: "n".repeat(43) }),
    );

    // Joins at T6 and sends a round.
    await page.goto("/#qr=aaa.bbb.ccc");
    await page.getByRole("button", { name: "Join this table", exact: true }).click();
    await expect(page).toHaveURL(/\/menu$/u);
    await page.evaluate(() => {
      history.pushState(null, "", "/checkout");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByRole("button", { name: /Place order · \$22\.60/u }).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    await expect(page.getByText("On the table's bill").first()).toBeVisible();

    // Staff merge this table into T7; the guest reloads the same page.
    table.moved = true;
    await page.reload();
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "Your table was merged into table T7" }),
    ).toBeVisible();
    await expect(main).toContainText("Everything your table ordered is on that table's bill.");
    await expect(main).toContainText("Scan the code on table T7");
    await expect(main).not.toContainText("Join your table first");
    await expectNoInternalText(page);

    // Scans T7's code and joins again: the round is on the table page.
    await page.goto("/#qr=ddd.eee.fff");
    await page.getByRole("button", { name: "Join this table", exact: true }).click();
    await expect(page).toHaveURL(/\/menu$/u);
    expect(table.rejoined).toBe(true);
    await page.evaluate(() => {
      history.pushState(null, "", "/dine-in/session");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByText("On the table's bill").first()).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("merged into table");
    expect(sent).toHaveLength(1);
    expect(failures).toEqual([]);
  });
});

// WP-2423 guest-cart-503 (v15 M06, live 07b7a1b7): a dish staff marked sold out is named at once
// (one quote, no busy wait), the guest removes it and the round goes; a mark on the cart says it
// before anyone taps, and anyone at the table can remove it; an open cart learns within one poll
// that staff started checkout.
for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet", width: 1024, height: 768, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Pay-later table, a dish not sold now " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    const press = async (locator: Locator) => {
      if (screen.touch) await locator.tap();
      else await locator.click();
    };
    test("names the dish on Place order, removes it, and the next tap sends", async ({ page }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const sent: { body: unknown; key: string | undefined }[] = [];
      const table = await stubTable(page, sent, {
        moreDishes: 1,
        otherDishes: true,
        quote: (route, call) =>
          call === 1
            ? route.fulfill({
                status: 409,
                json: {
                  schemaVersion: 1,
                  error: {
                    code: "quote_item_unavailable",
                    messageKey: "customer.quote.item_unavailable",
                    line: { cartItemReference: id(60) },
                  },
                },
              })
            : undefined,
      });
      await openCart(page);
      await press(placeOrder(page));
      const alert = page.getByRole("alert").filter({ hasText: "Synthetic dish 1" });
      await expect(alert).toHaveText(
        "Synthetic dish 1 isn’t available right now, so this round hasn’t been sent. Remove Synthetic dish 1, then tap Place order.",
      );
      // One quote, no busy wait and nothing sent.
      expect(table.calls.filter((call) => call === "quote")).toHaveLength(1);
      expect(sent).toEqual([]);
      await expect(page.getByRole("main")).not.toContainText("hasn’t been charged");
      const line = page.locator(`article[aria-labelledby="cart-item-${id(60)}"]`);
      await press(line.getByRole("button", { name: "Remove" }));
      await expect(line).toHaveCount(0);
      await press(placeOrder(page));
      await expect.poll(() => sent.length).toBe(1);
      await expectNoInternalText(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(failures).toEqual([]);
    });

    test("marks another guest's dish not sold now; this phone removes it, then orders", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const sent: { body: unknown; key: string | undefined }[] = [];
      await stubTable(page, sent, {
        moreDishes: 1,
        otherDishes: true,
        moreDishWarnings: ["OTHER_PARTICIPANT_ITEM", "ITEM_UNAVAILABLE"],
      });
      await openCart(page);
      const line = page.locator(`article[aria-labelledby="cart-item-${id(60)}"]`);
      await expect(line).toContainText("Not available right now. Remove it to order the rest.");
      await expect(line).toContainText(
        "Added by another guest. Anyone at the table can remove it now.",
      );
      await expect(
        line.getByRole("button", { name: "Increase Synthetic dish 1 quantity" }),
      ).toBeDisabled();
      await expect(placeOrder(page)).toBeDisabled();
      await expect(page.getByRole("main")).toContainText(
        "Remove the dishes that aren’t available right now, then order.",
      );
      await press(line.getByRole("button", { name: "Remove" }));
      await expect(line).toHaveCount(0);
      await expect(placeOrder(page)).toBeEnabled();
      await press(placeOrder(page));
      await expect.poll(() => sent.length).toBe(1);
      await expectNoInternalText(page);
      expect(failures).toEqual([]);
    });

    test("an open cart says the table is checking out within one poll", async ({ page }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      await page.clock.install();
      await stubTable(page);
      await openCart(page);
      await expect(placeOrder(page)).toBeEnabled();
      // Staff start checkout: every later cart read answers 409, never 503.
      let reads = 0;
      await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) => {
        reads += 1;
        return route.fulfill({
          status: 409,
          json: {
            schemaVersion: 1,
            error: {
              code: "cart_table_checking_out",
              messageKey: "customer.cart.table_checking_out",
            },
          },
        });
      });
      await page.clock.runFor(16_000);
      await expect(page.getByRole("main")).toContainText(
        "New dishes can’t be sent while the bill is being settled.",
      );
      await expect(page.getByRole("region", { name: "Your table is checking out" })).toBeVisible();
      expect(reads).toBeGreaterThanOrEqual(1);
      await expectNoInternalText(page);
      expect(failures).toEqual([]);
    });
  });
}
