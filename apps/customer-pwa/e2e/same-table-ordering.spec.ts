import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 (same-table-ordering, sim M37 and live2 double-payment): phones at one table see each
// other's changes within seconds. A phone part way through checkout is told, in plain words, that
// someone at the table added a dish (and checks out with the new total), or that someone at the
// table already paid and sent these dishes (and nothing is offered to pay twice), whatever was
// added since. Nothing reads while offline. Synthetic HTTP interception on the production PWA;
// "the other phone" is the server state the routes answer from. The database acceptance test
// (same-table-ordering) proves the round record on the server's side.
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => "018f8a20-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);

/** The cart's dishes on the menu, as the guest saw them. */
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

interface Table {
  version: number;
  items: { reference: number; name: string; quantity: number; other: boolean }[];
  rounds: {
    roundNumber: number;
    sentByThisPhone: boolean;
    lines: number[];
    paymentState?: "AwaitingPayment" | "Paid" | "PayLater" | "Cancelled" | "Returned";
    /** v15 batch-5: staff entered it; whether this phone's dishes are in it. */
    enteredByStaff?: boolean;
    withThisPhoneDishes?: boolean;
  }[];
  /** v15 batch 7: a phone's choice of what it pays for this round (absent: not told). */
  payer?: {
    thisPhone: boolean;
    choice: "Mine" | "Chosen";
    expiresAt: string;
    reserved: boolean;
  } | null;
  /** v15 batch 7: dishes staff took out lately (the cart's own record). */
  staffRemoved?: { removedAt: string; quantity: number; names: Record<string, string> }[];
  /** v15 batch-5: the table page's rounds (empty by default). */
  sessionRounds?: unknown[];
}
interface Seen {
  quotes: number;
  cartReads: number;
}

async function stubTable(page: Page, table: Table) {
  const seen: Seen = { quotes: 0, cartReads: 0 };
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill({ status: 200, json: { schemaVersion: 1, messages: [] } }),
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
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) => {
    seen.cartReads += 1;
    return route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: table.version,
          orderType: "DineIn",
          serviceMode: "DineIn",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Table Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: table.items.map((item) => ({
            cartItemReference: id(item.reference),
            sellableReference: id(3),
            displayName: item.name,
            quantity: item.quantity,
            configuration: [],
            customerNote: null,
            lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
            warnings: item.other ? ["OTHER_PARTICIPANT_ITEM"] : [],
          })),
          quote: null,
          warnings: [],
          recentRounds: table.rounds.map((round) => ({
            roundNumber: round.roundNumber,
            sentAt: new Date(Date.now() - 1000).toISOString(),
            sentByThisPhone: round.sentByThisPhone,
            cartItemReferences: round.lines.map(id),
            ...(round.paymentState === undefined ? {} : { paymentState: round.paymentState }),
            ...(round.enteredByStaff === undefined
              ? {}
              : {
                  enteredByStaff: round.enteredByStaff,
                  withThisPhoneDishes: round.withThisPhoneDishes ?? true,
                }),
          })),
          ...(table.payer === undefined
            ? {}
            : {
                tablePay: {
                  defaultChoice: "WholeTable",
                  payer: table.payer,
                  waiting: [],
                  returnable: table.payer === null,
                },
              }),
          ...(table.staffRemoved === undefined ? {} : { staffRemoved: table.staffRemoved }),
        },
      },
    });
  });
  await page.route("**/api/v1/carts/*/quote", (route) => {
    seen.quotes += 1;
    const subtotal = table.items.reduce((sum, item) => sum + item.quantity * 1000, 0);
    return route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        quote: {
          quoteReference: id(100 + seen.quotes),
          quoteVersion: 1,
          cartVersion: table.version,
          currency: "CAD",
          subtotal: { amountMinor: String(subtotal), currency: "CAD" },
          discount: { amountMinor: "0", currency: "CAD" },
          tax: { amountMinor: String((subtotal * 13) / 100), currency: "CAD" },
          fee: { amountMinor: "0", currency: "CAD" },
          total: { amountMinor: String((subtotal * 113) / 100), currency: "CAD" },
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
        checkout: {
          cartReference: id(1),
          cartVersion: table.version,
          orderType: "DineIn",
          details: null,
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
          cartVersion: table.version,
          orderType: "DineIn",
          checkedAt: new Date(Date.now() - 1000).toISOString(),
          validUntil: expiresAt,
          documents: [],
        },
      },
    }),
  );
  for (const path of ["session**", "table-payment", "staff-call", "invitation"])
    await page.route(`**/api/v1/dine-in/${path}`, (route) =>
      route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json:
          path === "session**"
            ? {
                schemaVersion: 1,
                session: {
                  tableLabel: "12",
                  orderNumber: table.sessionRounds === undefined ? null : "1042",
                  checkedAt: new Date().toISOString(),
                  paymentTiming: "PayFirst",
                  rounds: table.sessionRounds ?? [],
                  summary:
                    table.sessionRounds === undefined
                      ? null
                      : {
                          paid: { amountMinor: "0", currencyCode: "CAD" },
                          refunded: { amountMinor: "0", currencyCode: "CAD" },
                          refundPending: { amountMinor: "0", currencyCode: "CAD" },
                          due: { amountMinor: "1229", currencyCode: "CAD" },
                          // Only what is owed: the stopped rounds are not on it.
                          ordered: {
                            subtotal: { amountMinor: "1088", currencyCode: "CAD" },
                            tax: { amountMinor: "141", currencyCode: "CAD" },
                            total: { amountMinor: "1229", currencyCode: "CAD" },
                          },
                        },
                },
              }
            : path === "table-payment"
              ? {
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
                }
              : path === "staff-call"
                ? {
                    schemaVersion: 1,
                    staffCall: { open: null, recentlyClosed: null, nextCallAt: null },
                  }
                : { schemaVersion: 1, invitation: { canInvite: false } },
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

const mine = () => ({ reference: 2, name: "Synthetic noodles", quantity: 2, other: false });

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production One table, several phones " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });

    test("a dish another phone adds shows on this cart within 5 seconds", async ({ page }) => {
      const table: Table = { version: 3, items: [mine()], rounds: [] };
      await stubTable(page, table);
      await enterTable(page, "/cart");
      await expect(page.getByRole("heading", { name: "Synthetic noodles" })).toBeVisible();
      table.version = 4;
      table.items.push({ reference: 6, name: "Synthetic sesame soup", quantity: 1, other: true });
      await expect(page.getByRole("heading", { name: "Synthetic sesame soup" })).toBeVisible({
        timeout: 5_000,
      });
    });

    test("checking out while another phone adds: told what was added, then the new total", async ({
      page,
    }, info) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const table: Table = { version: 3, items: [mine()], rounds: [] };
      const seen = await stubTable(page, table);
      await enterTable(page, "/checkout");
      await page.getByRole("button", { name: "No tip", exact: true }).click();
      const pay = page.getByRole("button", { name: /Continue to payment · \$22\.60/u });
      await expect(pay).toBeEnabled();
      table.version = 4;
      table.items.push({ reference: 6, name: "Synthetic sesame soup", quantity: 1, other: true });
      const changed = page.getByRole("status").filter({
        hasText: "Someone at your table changed the cart: added Synthetic sesame soup ×1.",
      });
      await expect(changed).toBeVisible({ timeout: 6_000 });
      // Said beside the action the guest is at; the old total can't be paid now, one button
      // checks out with the new one.
      await expect(changed).toBeInViewport();
      await expect(page.getByRole("button", { name: /Continue to payment/u })).toHaveCount(0);
      const again = page.getByRole("button", { name: "Check out with the new total" });
      await expect(again).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`table-changed-${screen.width}.png`) });
      await again.click();
      await expect(changed).toHaveCount(0);
      await expect.poll(() => seen.quotes).toBeGreaterThanOrEqual(2);
      await page.getByRole("button", { name: "No tip", exact: true }).click();
      await expect(
        page.getByRole("button", { name: /Continue to payment · \$33\.90/u }),
      ).toBeEnabled();
      await expectNoInternalText(page);
      expect(failures).toEqual([]);
    });

    test("another phone paid and sent these dishes first, then someone added: nothing to pay twice", async ({
      page,
    }, info) => {
      const table: Table = { version: 3, items: [mine()], rounds: [] };
      await stubTable(page, table);
      await enterTable(page, "/checkout");
      await page.getByRole("button", { name: "No tip", exact: true }).click();
      // The other phone's round took the dishes; then a dish was added (the cart is two on).
      table.version = 5;
      table.items = [{ reference: 7, name: "Synthetic tea", quantity: 1, other: true }];
      table.rounds = [{ roundNumber: 1, sentByThisPhone: false, lines: [2] }];
      const main = page.getByRole("main");
      await expect(
        main.getByText("These dishes were paid and sent by someone at your table (round 1)."),
      ).toBeVisible({ timeout: 6_000 });
      await expect(main.getByText("Dishes added since then are still in the cart.")).toBeVisible();
      await expect(main.getByRole("link", { name: "See your table" })).toBeVisible();
      await expect(main.getByRole("button", { name: /Continue to payment/u })).toHaveCount(0);
      await expect(main.getByText("Tip", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`table-sent-${screen.width}.png`) });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expectNoInternalText(page);
    });

    test("an empty cart says another phone's round took its dishes", async ({ page }) => {
      const table: Table = {
        version: 4,
        items: [],
        rounds: [{ roundNumber: 2, sentByThisPhone: false, lines: [2] }],
      };
      await stubTable(page, table);
      await enterTable(page, "/cart");
      await expect(
        page.getByText("Round 2 was sent by someone at your table.", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "See your table" })).toBeVisible();
    });

    test("M38: while another phone is still paying, the cart says so instead of paid and sent", async ({
      page,
    }, info) => {
      const table: Table = {
        version: 4,
        items: [],
        rounds: [
          { roundNumber: 1, sentByThisPhone: false, lines: [2], paymentState: "AwaitingPayment" },
        ],
      };
      await stubTable(page, table);
      await enterTable(page, "/cart");
      await expect(
        page.getByText("Someone at your table is paying for round 1 now. Your dishes are in it.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByText(/was sent by someone|paid and sent/u)).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`table-being-paid-${screen.width}.png`) });
      // Closed unpaid: nothing claims the dishes came back.
      table.rounds = [
        { roundNumber: 1, sentByThisPhone: false, lines: [2], paymentState: "Cancelled" },
      ];
      table.version = 5;
      await expect(
        page.getByText(
          "Round 1 wasn’t paid, so it wasn’t sent to the kitchen. Add the dishes again to order them.",
          { exact: true },
        ),
      ).toBeVisible({ timeout: 6_000 });
      await expectNoInternalText(page);
    });

    test("nothing is read while offline, and the cart keeps up again by itself once back online", async ({
      page,
      context,
    }) => {
      const table: Table = { version: 3, items: [mine()], rounds: [] };
      const seen = await stubTable(page, table);
      await enterTable(page, "/cart");
      await expect(page.getByRole("heading", { name: "Synthetic noodles" })).toBeVisible();
      await context.setOffline(true);
      await page.waitForTimeout(500);
      const before = seen.cartReads;
      await page.waitForTimeout(9_000);
      expect(seen.cartReads).toBe(before);
      await context.setOffline(false);
      // Back online the cart reads at once by itself (93446b02: no refresh to tap), shows the
      // dishes again with no reconnect notice left, and from then on keeps up by itself.
      await expect.poll(() => seen.cartReads, { timeout: 3_000 }).toBeGreaterThan(before);
      const reconnected = seen.cartReads;
      await expect(page.getByRole("heading", { name: "Synthetic noodles" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh after reconnecting" })).toHaveCount(0);
      await expect.poll(() => seen.cartReads, { timeout: 6_000 }).toBeGreaterThan(reconnected);
    });
  });
}

test("@production M38: the phone paying for its round stops, and the dishes are back in the table's cart", async ({
  page,
}) => {
  // The payer pressed "Continue to payment": its round holds both phones' dishes, the cart is empty.
  const table: Table = {
    version: 4,
    items: [],
    rounds: [
      { roundNumber: 1, sentByThisPhone: true, lines: [2, 6], paymentState: "AwaitingPayment" },
    ],
  };
  await stubTable(page, table);
  const asked: { body: unknown; key: string | undefined }[] = [];
  await page.route("**/api/v1/dine-in/rounds/withdraw", (route) => {
    asked.push({
      body: route.request().postDataJSON(),
      key: route.request().headers()["idempotency-key"],
    });
    table.version = 6;
    table.items = [
      mine(),
      { reference: 7, name: "Synthetic sesame soup", quantity: 1, other: true },
    ];
    table.rounds = [
      { roundNumber: 1, sentByThisPhone: true, lines: [2, 6], paymentState: "Returned" },
    ];
    return route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, status: "Returned" },
    });
  });
  await enterTable(page, "/cart");
  await expect(page.getByText("You’re paying for round 1.", { exact: false })).toBeVisible();
  const stop = page.getByRole("button", { name: "Don’t pay. Put the dishes back" });
  await expect(stop).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(stop).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/round-withdraw-${width}.png`, fullPage: true });
  }
  await stop.click();
  await expect(
    page.getByText("Round 1 wasn’t paid, so it wasn’t ordered. Its dishes are back in the cart."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic sesame soup" })).toBeVisible();
  expect(asked).toHaveLength(1);
  expect(asked[0]?.body).toEqual({ roundNumber: 1 });
  expect(asked[0]?.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  // No internal references or codes on the page.
  expect(await page.locator("body").innerText()).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-7|GUEST_CANCELLED|AwaitingPayment|Returned\b/u,
  );
  await page.screenshot({ path: "test-results/round-withdraw-returned.png", fullPage: true });
});

// v15 batch 7 table-pay-by-dish (DEC-DINING-CHECKOUT-SCOPE 15): this phone chose to pay only its
// own dishes and is on checkout; staff take one of them out. The choice is over: the phone says
// staff did it, that nothing was charged, and sends the guest back to choose again. It never
// offers the whole table's new total on the old choice, nor calls the dishes that came back
// "added by someone at your table".
for (const screen of [
  { width: 1440, height: 900, touch: false },
  { width: 1024, height: 768, touch: false },
  { width: 390, height: 844, touch: true },
]) {
  test.describe("@production A pay choice ended by staff " + screen.width, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("staff take a dish out while this phone chose its dishes: choose again, nothing charged", async ({
      page,
    }, info) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const table: Table = {
        version: 3,
        items: [mine()],
        rounds: [],
        payer: {
          thisPhone: true,
          choice: "Mine",
          expiresAt: new Date(Date.now() + 240_000).toISOString(),
          reserved: true,
        },
      };
      await stubTable(page, table);
      await enterTable(page, "/checkout");
      await page.getByRole("button", { name: "No tip", exact: true }).click();
      await expect(
        page.getByRole("button", { name: /Continue to payment · \$22\.60/u }),
      ).toBeEnabled();
      table.version = 5;
      table.items = [{ reference: 6, name: "Synthetic sesame soup", quantity: 1, other: true }];
      table.payer = null;
      table.staffRemoved = [
        {
          removedAt: new Date().toISOString().replace(/\.\d{3}Z$/u, ".000Z"),
          quantity: 2,
          names: { "en-CA": "Synthetic noodles" },
        },
      ];
      const ended = page.getByRole("alert").filter({
        hasText:
          "Staff removed Synthetic noodles ×2 from the cart, so the dishes you chose to pay for are no longer set aside. Nothing was charged. Choose again what you pay for.",
      });
      await expect(ended).toBeVisible({ timeout: 6_000 });
      await expect(ended).toBeInViewport();
      await expect(page.getByText("Someone at your table changed the cart")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Check out with the new total" })).toHaveCount(
        0,
      );
      await expect(page.getByRole("button", { name: /Continue to payment/u })).toHaveCount(0);
      const again = page.getByRole("link", { name: "Choose again" });
      await expect(again).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`choice-ended-${screen.width}.png`) });
      await again.click();
      await expect(page).toHaveURL(/\/cart$/u);
      await expectNoInternalText(page);
      expect(failures).toEqual([]);
    });
  });
}

// v15 batch-5 (shared-table-staff-round): staff sent a round from the table's cart and took this
// phone's only dish out. The phone is told which dish staff took out and that staff take that
// round's payment on the card machine; it is never told someone is paying with its dishes in it.
// The table page reads the rounds its payers stopped as not charged, with no tax or total.
for (const width of [390, 1024, 1440])
  test(`@production v15 batch-5: a staff round and a stopped round read plainly at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const table: Table = {
      version: 7,
      items: [],
      staffRemoved: [
        {
          removedAt: new Date(Date.now() - 2000).toISOString(),
          quantity: 1,
          names: { "en-CA": "Steamed rice (TEST)" },
        },
      ],
      rounds: [
        {
          roundNumber: 1,
          sentByThisPhone: false,
          lines: [2],
          paymentState: "AwaitingPayment",
          enteredByStaff: true,
          withThisPhoneDishes: false,
        },
      ],
      sessionRounds: [2, 3].map((roundNumber) => ({
        roundNumber,
        orderedBy: "You",
        submittedAt: new Date(Date.now() - 60_000).toISOString(),
        status: "NotPaidCancelled",
        payment: "NotCharged",
        cancelsAt: null,
        storeCancellationReason: null,
        ...(roundNumber === 2 ? { stoppedBeforePaying: true } : {}),
        items: [
          {
            displayName: "Synthetic noodles",
            quantity: 1,
            servedQuantity: 0,
            cancelled: false,
            lineTotal: { amountMinor: "1331", currencyCode: "CAD" },
            priceBeforeTax: { amountMinor: "1178", currencyCode: "CAD" },
          },
        ],
        subtotal: { amountMinor: "1178", currencyCode: "CAD" },
        tax: { amountMinor: "153", currencyCode: "CAD" },
        itemsTotal: { amountMinor: "1331", currencyCode: "CAD" },
      })),
    };
    await stubTable(page, table);
    // The table page lists rounds 1..n: round 1 here is the staff round.
    table.sessionRounds = [
      {
        roundNumber: 1,
        orderedBy: "Staff",
        submittedAt: new Date(Date.now() - 30_000).toISOString(),
        status: "AwaitingPayment",
        payment: "Awaiting",
        cancelsAt: new Date(Date.now() + 25 * 60_000).toISOString(),
        storeCancellationReason: null,
        items: [
          {
            displayName: "Synthetic har gow",
            quantity: 1,
            servedQuantity: 0,
            cancelled: false,
            lineTotal: { amountMinor: "1229", currencyCode: "CAD" },
            priceBeforeTax: { amountMinor: "1088", currencyCode: "CAD" },
          },
        ],
        subtotal: { amountMinor: "1088", currencyCode: "CAD" },
        tax: { amountMinor: "141", currencyCode: "CAD" },
        itemsTotal: { amountMinor: "1229", currencyCode: "CAD" },
      },
      ...(table.sessionRounds ?? []),
    ];
    await enterTable(page, "/cart");
    await expect(page.getByText("Staff removed Steamed rice (TEST) from the cart.")).toBeVisible();
    await expect(
      page.getByText("Staff are taking payment for round 1 on the card machine."),
    ).toBeVisible();
    await expect(page.getByText("Someone at your table is paying", { exact: false })).toHaveCount(
      0,
    );
    await expect(page.getByText("Your dishes are in it", { exact: false })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/staff-round-cart-${width}.png`, fullPage: true });
    await page.getByRole("link", { name: "See your table" }).click();
    await expect(
      page.getByText(
        "This round was stopped before anyone paid, and its dishes went back to your table’s cart. Nobody was charged for it.",
      ),
    ).toBeVisible();
    const main = page.locator("main");
    await expect(main).not.toContainText("$1.53");
    await expect(main).not.toContainText("$13.31");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(await page.locator("body").innerText()).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-7|NotPaidCancelled|AwaitingPayment|stoppedBeforePaying/u,
    );
    await page.screenshot({ path: `test-results/staff-round-table-${width}.png`, fullPage: true });
  });
