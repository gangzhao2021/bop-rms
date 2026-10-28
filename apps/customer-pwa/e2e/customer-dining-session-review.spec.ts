import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));

// WP-2423 Q8: synthetic HTTP views exercise the production CUST-DINE-IN-SESSION page; these
// fixtures grant no real membership and contain no real Store, guest or payment data.
const id = (n: number) => `018f2330-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const session = {
  schemaVersion: 1,
  session: {
    tableLabel: "12",
    orderNumber: "1042",
    checkedAt: "2026-10-13T18:00:00.000Z",
    rounds: [
      {
        roundNumber: 1,
        orderedBy: "You",
        submittedAt: "2026-10-13T17:40:00.000Z",
        status: "Serving",
        payment: "Paid",
        cancelsAt: null,
        storeCancellationReason: null,
        items: [
          {
            displayName: "Synthetic tonkotsu ramen with extra chashu",
            quantity: 2,
            servedQuantity: 1,
            cancelled: false,
            lineTotal: cad("3398"),
          },
          {
            displayName: "Synthetic green tea",
            quantity: 1,
            servedQuantity: 0,
            cancelled: true,
            lineTotal: cad("339"),
          },
        ],
        itemsTotal: cad("3737"),
      },
      {
        roundNumber: 2,
        orderedBy: "AnotherGuest",
        submittedAt: "2026-10-13T17:55:00.000Z",
        status: "PaymentFailed",
        payment: "Failed",
        cancelsAt: "2026-10-13T18:25:00.000Z",
        storeCancellationReason: null,
        items: [
          {
            displayName: "Synthetic gyoza",
            quantity: 1,
            servedQuantity: 0,
            cancelled: false,
            lineTotal: cad("904"),
          },
        ],
        itemsTotal: cad("904"),
      },
    ],
    summary: {
      paid: cad("4282"),
      refunded: cad("0"),
      refundPending: cad("339"),
      due: cad("904"),
    },
  },
};

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

async function enterTable(page: Page, onSession: () => { status: number; json: unknown }) {
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Noodle Bar",
        publicStoreReference: id(6),
        publicTableReference: id(7),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: "s".repeat(43),
      },
    }),
  );
  await page.route("**/api/v1/dine-in/session", (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers()["x-csrf-token"]).toBe("s".repeat(43));
    expect(new URL(route.request().url()).search).toBe("");
    const { status, json } = onSession();
    return route.fulfill({ status, headers: { "cache-control": "no-store" }, json });
  });
  // WP-2423 Q28 DEC-DINING-STAFF-CALL: nobody at this table has asked for staff.
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
  // WP-2423 DEC-DINING-GUEST-INVITATION: this guest is not the table's host (no invite control).
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, invitation: { canInvite: false } },
    }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Noodle Bar", exact: true }),
  ).toBeVisible();
  // Same-document navigation retains the real Entry CSRF context, as after joining the table.
  await page.evaluate(() => {
    history.pushState(null, "", "/menu");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page
    .getByRole("navigation", { name: "Customer journey" })
    .getByRole("link", { name: "Your table" })
    .click();
  await expect(page).toHaveURL(/\/dine-in\/session$/u);
}

test.describe("@production CUST-DINE-IN-SESSION table view", () => {
  test.use({ serviceWorkers: "block" });

  test("shows the table's rounds, statuses and amounts at responsive widths", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await enterTable(page, () => ({ status: 200, json: session }));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Your table · 12" })).toBeVisible();
    await expect(main.getByText("Order 1042", { exact: true })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Round 1 · Ordered by you" })).toBeVisible();
    await expect(
      main.getByRole("heading", { name: "Round 2 · Ordered by another guest" }),
    ).toBeVisible();
    await expect(main.getByText("Being served", { exact: true })).toBeVisible();
    await expect(main.getByText("Served 1 of 2", { exact: true })).toBeVisible();
    await expect(main.getByText("On hold until paid", { exact: true })).toBeVisible();
    await expect(main.getByText(/This round will be cancelled at/u)).toBeVisible();
    const summary = main.getByRole("region", { name: "Table total" });
    await expect(summary.getByText("$42.82", { exact: true })).toBeVisible();
    await expect(summary.getByText("$9.04", { exact: true })).toBeVisible();
    await expect(summary.getByText("$3.39", { exact: true })).toBeVisible();
    // No internal codes or references reach the guest.
    await expect(main.getByText(/AnotherGuest|PaymentFailed|RefundPending|018f2330/u)).toHaveCount(
      0,
    );
    await expect(main.getByRole("link", { name: "Order more from the menu" })).toHaveAttribute(
      "href",
      "/menu",
    );

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await expectNoHorizontalOverflow(page);
      for (const card of await main.locator(".order-status__card").all()) {
        const box = await card.boundingBox();
        if (box === null) throw new Error("table card missing");
        expect(box.width).toBeLessThanOrEqual(width - 16);
      }
      const header = await page.locator(".bop-shell__header").boundingBox();
      if (header === null) throw new Error("Customer frame is incomplete");
      expect(header.width).toBe(width);
      if (width !== 320)
        await page.screenshot({
          path: `test-results/customer-dining-session-${width}.png`,
          fullPage: true,
        });
    }
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(errors).toEqual([]);
  });

  test("WP-2423 D5: lists item prices before tax, then subtotal, tax and total per round and table", async ({
    page,
  }) => {
    // Ramen $30.07 + $3.91 tax = $33.98; tea $3.00 + $0.39 = $3.39; gyoza $8.00 + $1.04 = $9.04.
    const [round1, round2] = session.session.rounds;
    if (round1 === undefined || round2 === undefined) throw new Error("fixture");
    const priced = {
      schemaVersion: 1,
      session: {
        ...session.session,
        rounds: [
          {
            ...round1,
            items: [
              { ...round1.items[0], priceBeforeTax: cad("3007") },
              { ...round1.items[1], priceBeforeTax: cad("300") },
            ],
            subtotal: cad("3307"),
            tax: cad("430"),
          },
          {
            ...round2,
            items: [{ ...round2.items[0], priceBeforeTax: cad("800") }],
            subtotal: cad("800"),
            tax: cad("104"),
          },
        ],
        summary: {
          ...session.session.summary,
          ordered: { subtotal: cad("4107"), tax: cad("534"), total: cad("4641") },
        },
      },
    };
    await enterTable(page, () => ({ status: 200, json: priced }));
    const main = page.getByRole("main");
    const round = main.getByRole("article", { name: "Round 1 · Ordered by you" });
    await expect(round.getByText("$30.07", { exact: true })).toBeVisible();
    await expect(round.getByText("$3.00", { exact: true })).toBeVisible();
    await expect(round.locator(".order-status__money")).toContainText("Subtotal$33.07");
    await expect(round.locator(".order-status__money")).toContainText("Tax$4.30");
    await expect(round.locator(".order-status__total")).toHaveText("Round total$37.37");
    const summary = main.getByRole("region", { name: "Table total" });
    await expect(summary.locator(".order-status__money")).toContainText("Subtotal$41.07");
    await expect(summary.locator(".order-status__money")).toContainText("Tax$5.34");
    await expect(summary.locator(".order-status__money")).toContainText("Total ordered$46.41");
    // What the table paid and still owes is the same as before.
    await expect(summary.getByText("$42.82", { exact: true })).toBeVisible();
    await expect(summary.getByText("$9.04", { exact: true })).toBeVisible();
    await expect(summary).toContainText("Item prices are before tax.");
    await expectNoInternalText(page);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoHorizontalOverflow(page);
    }
    await page.screenshot({
      path: "test-results/customer-dining-session-priced-320.png",
      fullPage: true,
    });
  });

  // WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): a round staff entered for the table.
  test("shows rounds staff entered for the table and how they are paid", async ({ page }) => {
    const [round1] = session.session.rounds;
    if (round1 === undefined) throw new Error("fixture");
    const staffRound = (roundNumber: number, status: string, payment: string) => ({
      ...round1,
      roundNumber,
      orderedBy: "Staff",
      submittedAt: "2026-10-13T17:58:00.000Z",
      status,
      payment,
      items: [
        {
          displayName: "Synthetic shoyu ramen",
          quantity: 1,
          servedQuantity: 0,
          cancelled: false,
          lineTotal: cad("2034"),
        },
      ],
      itemsTotal: cad("2034"),
    });
    await enterTable(page, () => ({
      status: 200,
      json: {
        schemaVersion: 1,
        session: {
          ...session.session,
          rounds: [
            round1,
            staffRound(2, "Queued", "Paid"),
            staffRound(3, "AwaitingPayment", "Awaiting"),
          ],
          summary: { ...session.session.summary, due: cad("2034") },
        },
      },
    }));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Round 2 · Entered by staff" })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Round 3 · Entered by staff" })).toBeVisible();
    const awaiting = main.getByRole("article", { name: "Round 3 · Entered by staff" });
    await expect(awaiting).toContainText(
      "Staff entered this round for your table. Pay them on the card machine and the kitchen starts it.",
    );
    await expect(
      main.getByRole("article", { name: "Round 2 · Entered by staff" }).getByText("Paid", {
        exact: true,
      }),
    ).toBeVisible();
    await expectNoInternalText(page);
    await expect(
      main.getByText(/\bStaff\b(?! entered)|StoreCardMachine|AwaitingPayment/u),
    ).toHaveCount(0);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await expectNoHorizontalOverflow(page);
    }
    await page.screenshot({
      path: "test-results/customer-dining-session-staff-round-390.png",
      fullPage: true,
    });
  });

  // WP-2423 Q26: the kitchen is making a dish again; the table is told which one, in plain words.
  test("tells the table which dish is being remade", async ({ page }) => {
    const [round1] = session.session.rounds;
    const [ramen, tea] = round1?.items ?? [];
    if (round1 === undefined || ramen === undefined || tea === undefined)
      throw new Error("fixture");
    await enterTable(page, () => ({
      status: 200,
      json: {
        schemaVersion: 1,
        session: {
          ...session.session,
          rounds: [
            {
              ...round1,
              items: [
                { ...ramen, beingRemade: true },
                { ...tea, displayName: "Synthetic gyoza", cancelled: false, servedQuantity: 1 },
              ],
            },
          ],
          summary: { ...session.session.summary, due: cad("0") },
        },
      },
    }));
    const round = page.getByRole("main").getByRole("article", { name: "Round 1 · Ordered by you" });
    const remade = round.getByRole("listitem").filter({ hasText: "Synthetic tonkotsu ramen" });
    await expect(remade).toContainText("Being remade · we'll bring it to your table shortly");
    // The dish being remade does not also claim it was served; the other dish still does.
    await expect(remade).not.toContainText("Served");
    await expect(round.getByRole("listitem").filter({ hasText: "Synthetic gyoza" })).toContainText(
      "Served 1 of 1",
    );
    await expect(round.getByText(/Being remade/u)).toHaveCount(1);
    await expectNoInternalText(page);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await expectNoHorizontalOverflow(page);
    }
    await page.screenshot({
      path: "test-results/customer-dining-session-remake-320.png",
      fullPage: true,
    });
  });

  test("asks a guest who has not joined to join first", async ({ page }) => {
    await enterTable(page, () => ({ status: 404, json: { schemaVersion: 1 } }));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Join your table first" })).toBeVisible();
    await expect(main.getByText("Round 1", { exact: false })).toHaveCount(0);
  });

  test("recovers after a failed load with Try again", async ({ page }) => {
    let response: { status: number; json: unknown } = { status: 503, json: { schemaVersion: 1 } };
    await enterTable(page, () => response);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "We couldn’t load your table" })).toBeVisible();
    response = { status: 200, json: session };
    await main.getByRole("button", { name: "Try again" }).click();
    await expect(main.getByRole("heading", { name: "Round 1 · Ordered by you" })).toBeVisible();
    await expect(main.getByRole("heading", { name: "We couldn’t load your table" })).toHaveCount(0);
  });
});

// A stand-in for Stripe's script: its secure card component mounts and confirms (test only).
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

test.describe("@production DEC-DINE-IN-PAY-LATER S4 the guest pays the whole table", () => {
  test.use({ serviceWorkers: "block" });

  // WP-2423 item 8 ④ (Figma "分单 / AA · v3"): the table split the bill evenly in three; this
  // guest pays one part with a tip on that part's own share; nobody's name is shown.
  test("pays one part of a split bill with its own tip", async ({ page }) => {
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
    const payLater = {
      schemaVersion: 1,
      session: {
        ...session.session,
        paymentTiming: "PayLater",
        rounds: [{ ...session.session.rounds[0], payment: "OnTableBill" }],
      },
    };
    let paying = false;
    const starts: unknown[] = [];
    const part = (partNumber: number, status: string) => ({
      partNumber,
      amountMinor: "3164",
      subtotalMinor: "2800",
      status,
    });
    await page.route("**/api/v1/dine-in/table-payment", (route) => {
      const body = route.request().postDataJSON() as { action: string };
      if (body.action === "Start") {
        starts.push(body);
        paying = true;
      }
      return route.fulfill({
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 1,
          payment: {
            tableLabel: "8",
            checkingOut: true,
            rounds: [],
            owed: { subtotalMinor: "5600", taxMinor: "728", totalMinor: "6328" },
            consistent: true,
            state: paying ? "Paying" : "NotPaid",
            attempt: paying ? { totalMinor: "3584", tipMinor: "420", partNumber: 2 } : null,
            receipt: null,
            split: {
              mode: "Even",
              paidParts: 1,
              remainingMinor: "6328",
              parts: [part(1, "Paid"), part(2, paying ? "Mine" : "ToPay"), part(3, "Paying")],
            },
          },
        },
      });
    });
    await page.route("**/api/v1/dine-in/table-payment/handoff", (route) =>
      route.fulfill({
        headers: { "cache-control": "no-store" },
        json: { schemaVersion: 1, clientSecret: "pi_SYNTHETIC_secret_SYNTHETIC" },
      }),
    );
    await enterTable(page, () => ({ status: 200, json: payLater }));
    const pay = page.getByRole("region", { name: "Pay the bill" });
    await expect(pay).toContainText("Your table split the bill evenly in 3 parts.");
    await expect(pay).toContainText("1 of 3 parts paid · $63.28 to go");
    await expect(pay.getByRole("radio", { name: /^Part 1 · \$31\.64 · paid/u })).toBeDisabled();
    await expect(
      pay.getByRole("radio", { name: /^Part 3 · \$31\.64 · being paid/u }),
    ).toBeDisabled();
    await expect(pay.getByRole("radio", { name: /^Part 2 · \$31\.64$/u })).toBeChecked();
    // The tip is on this part's own share before tax: 15% of $28.00.
    await pay.getByRole("radio", { name: /15% · \$4\.20/u }).check();
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await pay.screenshot({ path: `test-results/guest-split-pay-${width}.png` });
    }
    await pay.getByRole("button", { name: "Pay $35.84" }).click();
    await expect(pay).toContainText("Paying $35.84 for part 2, tip included.");
    expect(starts).toEqual([
      {
        action: "Start",
        operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        tip: { kind: "Percent", percent: 15 },
        partNumber: 2,
      },
    ]);
    await expectNoInternalText(page);
  });

  test("chooses the tip once, pays with a card and gets the whole table's receipt", async ({
    page,
  }) => {
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
    const payLater = {
      schemaVersion: 1,
      session: {
        ...session.session,
        paymentTiming: "PayLater",
        rounds: [{ ...session.session.rounds[0], payment: "OnTableBill" }],
      },
    };
    const base = {
      tableLabel: "12",
      checkingOut: true,
      rounds: [
        {
          roundNumber: 1,
          items: [{ displayName: "Synthetic tonkotsu ramen", subtotalMinor: "1800" }],
          totalMinor: "2034",
        },
      ],
      owed: { subtotalMinor: "1800", taxMinor: "234", totalMinor: "2034" },
      consistent: true,
    };
    let state: "NotPaid" | "Paying" | "Paid" = "NotPaid";
    let handedOff = false;
    const starts: unknown[] = [];
    const answer = () => ({
      schemaVersion: 1,
      payment: {
        ...base,
        state,
        attempt: state === "Paying" ? { totalMinor: "2304", tipMinor: "270" } : null,
        receipt:
          state === "Paid"
            ? {
                method: "Online",
                roundsMinor: "2034",
                tipMinor: "270",
                roundingMinor: "0",
                totalMinor: "2304",
                paidAt: "2026-10-13T18:30:00.000Z",
              }
            : null,
      },
    });
    await page.route("**/api/v1/dine-in/table-payment", (route) => {
      const body = route.request().postDataJSON() as { action: string };
      if (body.action === "Start") {
        starts.push(body);
        state = "Paying";
      }
      // The Provider reports the card payment once the guest confirmed it.
      else if (state === "Paying" && handedOff) state = "Paid";
      return route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: answer(),
      });
    });
    await page.route("**/api/v1/dine-in/table-payment/handoff", (route) => {
      handedOff = true;
      return route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { schemaVersion: 1, clientSecret: "pi_SYNTHETIC_secret_SYNTHETIC" },
      });
    });
    const paidSession = {
      ...payLater,
      session: {
        ...payLater.session,
        summary: { ...payLater.session.summary, paid: cad("2304"), due: cad("0") },
      },
    };
    await enterTable(page, () => ({
      status: 200,
      json: state === "Paid" ? paidSession : payLater,
    }));
    const pay = page.getByRole("region", { name: "Pay the bill" });
    await expect(pay).toBeVisible();
    // No tip is chosen for the guest: every option, "No tip" included, alike; choose to pay.
    for (const name of ["No tip", /10% · /u, /15% · /u, /18% · /u])
      await expect(pay.getByRole("radio", { name })).not.toBeChecked();
    await expect(pay.getByRole("button", { name: "Choose a tip to pay" })).toBeDisabled();
    // Checking out: no more rounds from the phone; staff add dishes.
    await expect(page.getByRole("link", { name: "Order more from the menu" })).toHaveCount(0);
    await expect(
      page.getByText("Your table is checking out. To add dishes, ask a staff member."),
    ).toBeVisible();
    // The tip is chosen once for the whole table: 15% of the bill before tax.
    await pay.getByRole("radio", { name: /15% · \$2\.70/u }).check();
    // Leaving the table page and coming back keeps the choice for this checkout.
    await page
      .getByRole("navigation", { name: "Customer journey" })
      .getByRole("link", { name: "Menu" })
      .click();
    await page
      .getByRole("navigation", { name: "Customer journey" })
      .getByRole("link", { name: "Your table" })
      .click();
    await expect(
      page.getByRole("region", { name: "Pay the bill" }).getByRole("radio", { name: /15% · /u }),
    ).toBeChecked();
    await pay.getByRole("button", { name: "Pay $23.04" }).click();
    await expect(pay).toContainText("Paying $23.04 for the whole table, tip included.");
    // The browser sends only the tip chosen and its own operation (never an amount).
    expect(starts).toEqual([
      {
        action: "Start",
        operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        tip: { kind: "Percent", percent: 15 },
      },
    ]);
    await pay.getByRole("button", { name: "Pay securely" }).click();
    const receipt = page.getByRole("region", { name: "Receipt" });
    await expect(receipt).toContainText("$23.04", { timeout: 10000 });
    await expect(receipt).toContainText("Card on a guest’s phone");
    await expect(receipt).toContainText("$2.70");
    // Paid in full: the table's total says so (read again), and nothing more is offered to order.
    await expect(
      page.getByRole("region", { name: "Table total" }).getByText("$23.04", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Your table is checking out.")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Order more from the menu" })).toHaveCount(0);
    for (const width of [390, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
    }
    await expectNoInternalText(page);
  });
});
