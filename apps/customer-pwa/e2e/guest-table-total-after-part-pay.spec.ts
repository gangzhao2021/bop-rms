import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 51 (v15 b50 live, guest-pay-label-and-cart-cadence new finding): right after guest A paid
// only their own dish ($14.13 of a $28.25 bill, by dish), A's Your table page disagreed with itself
// for about 10 s. The pay section said "1 paid so far · $14.12 to go" and "· you paid", while the
// Table total lower on the page still read "Paid so far $0.00 / To pay at the end $28.25" until its
// next 15 s read. The pay section learns of a payment (this phone's or another guest's) from its
// own read; the table's total and rounds come from the table read, which now runs at once too.
// Synthetic HTTP interception on the production PWA, in the shapes v15 answered (TM2, G50 Pay).
//
// Batch 52 (v15 b51 live, guest-table-total-after-part-pay): the Table total named what the table
// owes three ways for one line ("To pay at the end", then "Still to pay", then "To pay at the end ·
// Nothing" once all was paid); at 1024/1440 its amounts sat in left-hand columns while Total sat at
// the far right; and every visit to Your table at a Store with calling staff off asked for the
// staff call again and got 409 (TM2's setting, not the checkout).
//
// Batch 53 (v15 b52 live, guest-table-total-wording-and-staff-call new findings): once the bill was
// paid in full in 2 by-dish payments, the note under the Table total read "The table paid once at
// the end" (这桌已在最后一起付清): the server stopped sending the split's parts once paid in full.
// And while part paid, the note said "Cash is rounded to the nearest 5 cents." although the rest
// is paid on a phone, unrounded: rounding is now said only for cash at the counter.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });
const id = (n: number) => "018f8a51-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const tm2 = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
};
const tableLabel = "G50 Pay (TEST)";
const dish = "Beef noodles (TEST)";
const height = 844;
const sentAt = new Date(Date.now() - 1_800_000).toISOString();
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
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

/**
 * Who paid a part of the bill: nobody yet, this phone (round 1), another guest (round 2), or the
 * whole bill by dish (both parts).
 */
type Paid = "nobody" | "me" | "other" | "all";
interface Table {
  /** Another guest started paying their own dish before this page was opened. */
  readonly otherPaying: boolean;
  /** This phone started its payment (Start answered). */
  started: boolean;
  /** This phone confirmed its card (the Provider reports it on the next read). */
  confirmed: boolean;
  paid: Paid;
}

const dishOf = (round: 1 | 2) => ({
  orderItemReference: id(round === 1 ? 0xa1 : 0xc2),
  displayName: dish,
  roundNumber: round,
  mine: round === 1,
  unitMinor: [round === 1 ? "1413" : "1412"],
  unitSubtotalMinor: ["1250"],
});
const partOf = (
  round: 1 | 2,
  status: "Paid" | "Mine" | "Paying",
  byYou: boolean,
  partNumber = 1,
) => ({
  partNumber,
  amountMinor: round === 1 ? "1413" : "1412",
  subtotalMinor: "1250",
  dishes: [{ displayName: dish, quantity: 1, shared: false }],
  status,
  byYou,
  tables: [],
  roundNumbers: [],
});

/** The table's payment view as v15 answered it to guest A at each moment. */
function paymentView(table: Table) {
  if (table.paid === "all")
    // As v15 answered once both guests had paid their own dish (order 64).
    return {
      schemaVersion: 1,
      payment: {
        refundedMinor: "0",
        tableLabel,
        checkingOut: true,
        rounds: [],
        owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0", taxRoundingMinor: "0" },
        consistent: true,
        matchesOrderApartFromSplit: true,
        tips: { enabled: true, tierPercents: [10, 15, 18] },
        state: "Paid",
        attempt: null,
        split: {
          mode: "ByGuests",
          stale: false,
          paidInFull: true,
          paidParts: 2,
          remainingMinor: "0",
          parts: [partOf(1, "Paid", true, 1), partOf(2, "Paid", false, 2)],
        },
        choices: null,
        receipt: null,
      },
    };
  const paidRound = table.paid === "me" ? 1 : table.paid === "other" ? 2 : null;
  const owedMinor = paidRound === 1 ? "1412" : paidRound === 2 ? "1413" : "2825";
  const owedTax = paidRound === 1 ? "162" : paidRound === 2 ? "163" : "325";
  const state =
    table.paid === "me" || table.paid === "other"
      ? "NotPaid"
      : table.started
        ? "Paying"
        : table.otherPaying
          ? "AnotherGuestPaying"
          : "NotPaid";
  const split =
    paidRound !== null
      ? {
          mode: "ByGuests",
          stale: false,
          paidInFull: false,
          paidParts: 1,
          remainingMinor: owedMinor,
          parts: [partOf(paidRound, "Paid", paidRound === 1)],
        }
      : table.started || table.otherPaying
        ? {
            mode: "ByGuests",
            stale: false,
            paidInFull: false,
            paidParts: 0,
            remainingMinor: "2825",
            parts: [partOf(table.started ? 1 : 2, table.started ? "Mine" : "Paying", false)],
          }
        : null;
  const left = ([1, 2] as const).filter(
    (round) => round !== paidRound && !(table.otherPaying && !table.started && round === 2),
  );
  return {
    schemaVersion: 1,
    payment: {
      refundedMinor: "0",
      tableLabel,
      checkingOut: true,
      rounds: [
        {
          roundNumber: 1,
          items: [{ displayName: dish, subtotalMinor: "1250" }],
          totalMinor: "1413",
        },
        {
          roundNumber: 2,
          items: [{ displayName: dish, subtotalMinor: "1250" }],
          totalMinor: "1412",
        },
      ],
      owed: {
        subtotalMinor: paidRound === null ? "2500" : "1250",
        taxMinor: owedTax,
        totalMinor: owedMinor,
        taxRoundingMinor: "0",
      },
      consistent: true,
      matchesOrderApartFromSplit: true,
      tips: { enabled: true, tierPercents: [10, 15, 18] },
      state,
      attempt: state === "Paying" ? { totalMinor: "1413", tipMinor: "0", partNumber: 1 } : null,
      split,
      choices:
        state === "Paying" || state === "AnotherGuestPaying"
          ? null
          : {
              defaultScope: "WholeTable",
              mine: left.includes(1) ? { count: 1, amountMinor: "1413" } : null,
              addedAny: true,
              mineUnavailable: false,
              dishes: left.map(dishOf),
              rounds: [
                {
                  roundNumber: 1,
                  restMinor: left.includes(1) ? "1413" : "0",
                  restSubtotalMinor: left.includes(1) ? "1250" : "0",
                },
                {
                  roundNumber: 2,
                  restMinor: left.includes(2) ? "1412" : "0",
                  restSubtotalMinor: left.includes(2) ? "1250" : "0",
                },
              ],
            },
      receipt: null,
    },
  };
}

/** The table read, as v15 answered it: a round paid in full by dish reads Paid (batch 51). */
function sessionView(table: Table) {
  const round = (number: 1 | 2) => {
    const total = number === 1 ? "1413" : "1412";
    const tax = number === 1 ? "163" : "162";
    const paid =
      table.paid === "all" ||
      (table.paid === "me" && number === 1) ||
      (table.paid === "other" && number === 2);
    return {
      roundNumber: number,
      orderedBy: number === 1 ? "You" : "AnotherGuest",
      submittedAt: sentAt,
      status: "Served",
      payment: paid ? "Paid" : "OnTableBill",
      cancelsAt: null,
      storeCancellationReason: null,
      items: [
        {
          displayName: dish,
          quantity: 1,
          servedQuantity: 1,
          cancelled: false,
          lineTotal: money(total),
          priceBeforeTax: money("1250"),
        },
      ],
      subtotal: money("1250"),
      tax: money(tax),
      itemsTotal: money(total),
      bill: {
        items: money("1250"),
        takenOff: money("0"),
        pointsUsed: money("0"),
        subtotal: money("1250"),
        tax: money(tax),
        total: money(total),
      },
    };
  };
  const paidMinor =
    table.paid === "all"
      ? "2825"
      : table.paid === "me"
        ? "1413"
        : table.paid === "other"
          ? "1412"
          : "0";
  const dueMinor =
    table.paid === "all"
      ? "0"
      : table.paid === "me"
        ? "1412"
        : table.paid === "other"
          ? "1413"
          : "2825";
  return {
    schemaVersion: 1,
    session: {
      tableLabel,
      orderNumber: "49",
      checkedAt: sentAt,
      paymentTiming: "PayLater",
      rounds: [round(1), round(2)],
      summary: {
        paid: money(paidMinor),
        refunded: money("0"),
        refundPending: money("0"),
        due: money(dueMinor),
        ordered: { subtotal: money("2500"), tax: money("325"), total: money("2825") },
        // v15 sends the table's bill as staff print it (b13); the Table total shows it.
        bill: {
          items: money("2500"),
          takenOff: money("0"),
          pointsUsed: money("0"),
          subtotal: money("2500"),
          tax: money("325"),
          total: money("2825"),
        },
        // v15 adds the table's payments' tip and cash rounding once any part is paid.
        ...(table.paid === "nobody" ? {} : { tableTip: money("0"), cashRounding: money("0") }),
        // Batch 53: the split's parts, also once paid in full (customerSplitParts).
        ...(table.paid === "nobody"
          ? {}
          : { splitParts: { count: null, paid: table.paid === "all" ? 2 : 1 } }),
      },
    },
  };
}

/** Each GET of the staff call this page made. */
const staffCallReads = new WeakMap<Page, number>();

async function stubTable(page: Page, table: Table) {
  const json = (status: number, body: unknown) => ({
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        csrfToken: "d".repeat(43),
        menuContext: {
          publicStoreReference: id(4),
          channel: "DineIn",
          locale: "en-CA",
          ...tm2,
        },
        visit: { publicTableReference: id(5), joined: true },
      }),
    ),
  );
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, messages: [] })),
  );
  // The table is checking out: the cart refuses changes, as v15 answers it.
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) =>
    route.fulfill(
      json(409, {
        schemaVersion: 1,
        error: { code: "cart_table_checking_out", messageKey: "customer.cart.table_checking_out" },
      }),
    ),
  );
  await page.route("**/bff/customer/payment-configuration", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        mode: "stripe",
        publishableKey: "pk_test_SyntheticBrowserOnly",
        returnUrl: "https://synthetic-return.invalid/return",
        wallets: false,
        internalTestEntry: false,
      }),
    ),
  );
  await page.route("https://js.stripe.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: syntheticStripe }),
  );
  await page.route("**/api/v1/dine-in/table-payment/handoff", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, clientSecret: "pi_SYNTHETIC_secret_SYNTHETIC" })),
  );
  await page.route("**/api/v1/dine-in/table-payment", (route) => {
    const body = route.request().postDataJSON() as { action?: string; choice?: unknown };
    if (body.action === "Start") {
      expect(body.choice).toEqual({ kind: "Mine" });
      table.started = true;
    }
    // The Provider reports the card payment on the read after the guest confirmed it.
    else if (table.started && table.confirmed && table.paid === "nobody") table.paid = "me";
    return route.fulfill(json(200, paymentView(table)));
  });
  // TM2 has calling staff turned off (v15 rms_dining.dining_service_setting): v15 answers 409.
  staffCallReads.set(page, 0);
  await page.route("**/api/v1/dine-in/staff-call", (route) => {
    if (route.request().method() === "GET")
      staffCallReads.set(page, (staffCallReads.get(page) ?? 0) + 1);
    return route.fulfill(
      json(409, {
        schemaVersion: 1,
        error: {
          code: "dining_staff_call_not_offered",
          messageKey: "customer.dining.staff_call.not_offered",
        },
      }),
    );
  });
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, invitation: { canInvite: false } })),
  );
  await page.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill(json(200, sessionView(table))),
  );
}

function words(zh: boolean) {
  return {
    pay: zh ? "结账付款" : "Pay the bill",
    total: zh ? "本桌合计" : "Table total",
    paidSoFar: zh ? "已付" : "Paid so far",
    stillToPay: zh ? "还剩" : "Still to pay",
    toPayAtEnd: zh ? "最后结账" : "To pay at the end",
    paidAll: zh ? "已付款" : "Paid",
    nothing: zh ? "无" : "Nothing",
    allPaid: zh
      ? "账单都已付清（共 2 笔），谢谢！"
      : "Everything on the bill is paid (2 payments). Thank you!",
    paidRound: zh ? "已付款" : "Paid",
    onBill: zh ? "记入本桌账单" : "On the table's bill",
    progress: zh
      ? "这桌正在按菜付：已付 1 笔 · 还剩 $14.12。"
      : "Your table is paying by dish: 1 paid so far · $14.12 to go.",
    otherProgress: zh
      ? "这桌正在按菜付：已付 1 笔 · 还剩 $14.13。"
      : "Your table is paying by dish: 1 paid so far · $14.13 to go.",
    mine: zh ? "只付我加的（1 道 · $14.13）" : "Only what I added (1 · $14.13)",
    noTip: zh ? "不加小费" : "No tip",
    payMine: zh ? "支付 $14.13" : "Pay $14.13",
    paySecurely: zh ? "安全付款" : "Pay securely",
    partNote: zh
      ? "这桌按菜付款，已付 1 笔。在柜台付现金按 5 分取整，刷卡和手机付款不取整。"
      : "The table is paying by dish; 1 paid so far. Cash at the counter is rounded to the nearest 5 cents; card and phone payments are not.",
    oldPartRounding: zh ? "已付 1 笔。现金按 5 分取整" : "1 paid so far. Cash is rounded",
    allNote: zh
      ? "这桌已按菜分 2 笔付清。现金按 5 分取整，刷卡和手机付款不取整。"
      : "The table paid by dish, in 2 payments. Cash is rounded to the nearest 5 cents; card and phone payments are not rounded.",
    oldAllNote: zh ? "最后一起" : "once at the end",
  };
}

/** The Table total's two lines, as a guest reads them. */
async function totals(page: Page, zh: boolean) {
  const text = words(zh);
  const summary = page.getByRole("region", { name: text.total });
  const line = (label: string) =>
    summary.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });
  return {
    summary,
    paid: line(text.paidSoFar).locator("dd"),
    due: line(text.stillToPay).locator("dd"),
  };
}

/** The Table total's lines as label/amount pairs, top to bottom. */
async function totalLines(page: Page, zh: boolean) {
  const { summary } = await totals(page, zh);
  return summary
    .locator("dl > div, p.order-status__total")
    .evaluateAll((rows) =>
      rows.map((row) => [
        (row.firstElementChild?.textContent ?? "").trim(),
        (row.lastElementChild?.textContent ?? "").trim(),
      ]),
    );
}

/**
 * Every amount of the Table total sits in one column: right edges within 1 px, and each label
 * leaves at least 40 px before its amount (room for wider Linux fonts).
 */
async function expectOneAmountColumn(page: Page, zh: boolean) {
  const { summary } = await totals(page, zh);
  const rows = await summary.locator("dl > div, p.order-status__total").evaluateAll((all) =>
    all.map((row) => {
      const label = (row.firstElementChild as HTMLElement).getBoundingClientRect();
      const amount = (row.lastElementChild as HTMLElement).getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(row.lastElementChild as HTMLElement);
      const text = range.getBoundingClientRect();
      const labelText = document.createRange();
      labelText.selectNodeContents(row.firstElementChild as HTMLElement);
      return {
        row: (row.textContent ?? "").trim(),
        amountRight: text.right,
        gap: text.left - labelText.getBoundingClientRect().right,
        sameLine: Math.abs(amount.top - label.top) < 12,
      };
    }),
  );
  expect(rows.length).toBeGreaterThanOrEqual(4);
  const right = rows[0]?.amountRight ?? 0;
  for (const row of rows) {
    expect(Math.abs(row.amountRight - right), row.row).toBeLessThanOrEqual(1);
    expect(row.gap, row.row).toBeGreaterThanOrEqual(40);
    expect(row.sameLine, row.row).toBe(true);
  }
}

/** Round N's "Payment" line on its card. */
const roundPayment = (page: Page, zh: boolean, round: number) =>
  page
    .getByRole("article", {
      name: new RegExp(`^${zh ? `第 ${round} 轮` : `Round ${round}`} ·`, "u"),
    })
    .locator("dl > div")
    .filter({ has: page.getByText(zh ? "付款" : "Payment", { exact: true }) })
    .locator("dd");

async function openTable(page: Page, table: Table, zh: boolean) {
  await page.clock.install();
  await stubTable(page, table);
  await page.goto("/dine-in/session");
  const toZh = page.getByRole("button", { name: "切换到中文" });
  if (zh && (await toZh.count()) > 0) await toZh.click();
  const pay = page.getByRole("region", { name: words(zh).pay });
  await expect(pay).toBeVisible();
  await page.waitForLoadState("networkidle");
  // From here the page's own timers run only when the test moves the clock: its regular 15 s
  // table read can't be what brings the total up to date.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
  return pay;
}

/** The whole page tells one story, inside the gutter with room for wider (Linux) fonts. */
async function expectLayout(page: Page, zh: boolean, width: number) {
  const { summary } = await totals(page, zh);
  const box = await summary.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? 0).toBeGreaterThanOrEqual(15);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  // The amounts sit on their labels' line with room to spare (40 px for wider fonts).
  for (const dd of await summary.locator("dl > div > dd").all())
    expect(await dd.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0);
  await expectNoInternalText(page);
}

/** Moves the paused clock on in half-second steps, letting each answer arrive in between. */
async function advance(page: Page, ms: number) {
  for (let done = 0; done < ms; done += 500) {
    await page.clock.runFor(500);
    await page.waitForTimeout(25);
  }
}

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN Your table after a part of the bill is paid (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height }, hasTouch: width < 768, isMobile: width < 768 });

      test("this phone pays only its own dish: the Table total and round 1 say so at once", async ({
        page,
      }) => {
        test.setTimeout(60_000);
        const text = words(zh);
        const table: Table = {
          otherPaying: false,
          started: false,
          confirmed: false,
          paid: "nobody",
        };
        const pay = await openTable(page, table, zh);
        const before = await totals(page, zh);
        await expect(before.paid).toHaveText("$0.00");
        await expect(roundPayment(page, zh, 1)).toHaveText(text.onBill);

        await pay.getByRole("radio", { name: text.mine, exact: true }).check();
        await pay.getByRole("radio", { name: text.noTip }).check();
        await pay.getByRole("button", { name: text.payMine }).click();
        // The guest confirms the card; the Provider reports it to the server.
        const confirm = pay.getByRole("button", { name: text.paySecurely });
        await expect(confirm).toBeVisible();
        table.confirmed = true;
        await confirm.click();
        // The pay section reads the result again 3 s later and learns of the payment.
        await advance(page, 3_500);
        await expect(pay).toContainText(text.progress);
        // Same moment, same page: the total and the round agree with it, with no 15 s wait.
        const after = await totals(page, zh);
        await expect(after.paid).toHaveText("$14.13", { timeout: 2_000 });
        await expect(after.due).toHaveText("$14.12", { timeout: 2_000 });
        await expect(roundPayment(page, zh, 1)).toHaveText(text.paidRound, { timeout: 2_000 });
        // Round 2 (another guest's dish) is still to pay: never claimed paid.
        await expect(roundPayment(page, zh, 2)).toHaveText(text.onBill);
        await expectLayout(page, zh, width);
        await page.screenshot({
          path: `test-results/b51-total-after-my-part-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });
      });

      test("batch 52: what the table owes has one name per moment; amounts line up; staff call asked once", async ({
        page,
      }) => {
        test.setTimeout(60_000);
        const text = words(zh);
        const table: Table = {
          otherPaying: false,
          started: false,
          confirmed: false,
          paid: "nobody",
        };
        const pay = await openTable(page, table, zh);
        const total = zh ? "合计" : "Total";
        // Nothing paid yet: the table pays this at the end.
        await expect
          .poll(() => totalLines(page, zh))
          .toEqual([
            [zh ? "小计" : "Subtotal", "$25.00"],
            [zh ? "税" : "Tax", "$3.25"],
            [total, "$28.25"],
            [text.paidSoFar, "$0.00"],
            [text.toPayAtEnd, "$28.25"],
          ]);
        await expectOneAmountColumn(page, zh);
        await expectLayout(page, zh, width);
        // Another guest pays their dish: what is left is still to pay.
        table.paid = "other";
        await advance(page, 3_500);
        await expect(pay).toContainText(text.otherProgress);
        await expect
          .poll(() => totalLines(page, zh), { timeout: 2_000 })
          .toEqual([
            [zh ? "小计" : "Subtotal", "$25.00"],
            [zh ? "税" : "Tax", "$3.25"],
            [total, "$28.25"],
            [text.paidSoFar, "$14.12"],
            [text.stillToPay, "$14.13"],
          ]);
        // Batch 53: the rest is paid on a phone, unrounded: rounding is said for cash only.
        const { summary: partSummary } = await totals(page, zh);
        await expect(partSummary).toContainText(text.partNote);
        await expect(partSummary).not.toContainText(text.oldPartRounding);
        await expectOneAmountColumn(page, zh);
        await expectLayout(page, zh, width);
        await page.screenshot({
          path: `test-results/b52-total-part-paid-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });
        // The rest is paid: the bill says it was paid, and names nothing left to pay.
        table.paid = "all";
        await advance(page, 3_500);
        await expect(pay).toContainText(text.allPaid);
        await expect
          .poll(() => totalLines(page, zh), { timeout: 2_000 })
          .toEqual([
            [zh ? "小计" : "Subtotal", "$25.00"],
            [zh ? "税" : "Tax", "$3.25"],
            [total, "$28.25"],
            [text.paidAll, "$28.25"],
          ]);
        const { summary } = await totals(page, zh);
        for (const gone of [text.toPayAtEnd, text.stillToPay, text.nothing])
          await expect(summary.getByText(gone, { exact: true })).toHaveCount(0);
        // Batch 53: paid in 2 by-dish payments, as the pay section says: never once at the end.
        await expect(summary).toContainText(text.allNote);
        await expect(summary).not.toContainText(text.oldAllNote);
        await expectOneAmountColumn(page, zh);
        await expectLayout(page, zh, width);
        await page.screenshot({
          path: `test-results/b52-total-all-paid-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });
        // TM2 has calling staff off: asked once on opening, never again while paying.
        expect(staffCallReads.get(page)).toBe(1);
        await expect(
          page.getByRole("heading", { name: zh ? "需要店员吗？" : "Need a staff member?" }),
        ).toHaveCount(0);
      });

      test("batch 52: going to the menu and back while paying does not ask for the staff call again", async ({
        page,
      }) => {
        test.setTimeout(60_000);
        const table: Table = {
          otherPaying: false,
          started: false,
          confirmed: false,
          paid: "other",
        };
        await openTable(page, table, zh);
        expect(staffCallReads.get(page)).toBe(1);
        const nav = page.getByRole("navigation");
        for (let visit = 0; visit < 3; visit += 1) {
          await nav.getByRole("link", { name: zh ? "菜单" : "Menu", exact: true }).click();
          await expect(page).toHaveURL(/\/menu/u);
          await nav.getByRole("link", { name: zh ? "本桌" : "Your table", exact: true }).click();
          await expect(page.getByRole("region", { name: words(zh).total })).toBeVisible();
          await advance(page, 1_000);
        }
        // The Store's answer (calling staff off) still holds: no 409 on every visit.
        expect(staffCallReads.get(page)).toBe(1);
        await expect(
          page.getByRole("heading", { name: zh ? "需要店员吗？" : "Need a staff member?" }),
        ).toHaveCount(0);
      });

      test("another guest pays their own dish: the Table total follows the pay section at once", async ({
        page,
      }) => {
        test.setTimeout(60_000);
        const text = words(zh);
        const table: Table = {
          otherPaying: true,
          started: false,
          confirmed: false,
          paid: "nobody",
        };
        const pay = await openTable(page, table, zh);
        await expect((await totals(page, zh)).paid).toHaveText("$0.00");
        // Guest C's card goes through; this page's pay section reads it on its next 3 s read.
        table.paid = "other";
        await advance(page, 3_500);
        await expect(pay).toContainText(text.otherProgress);
        const after = await totals(page, zh);
        await expect(after.paid).toHaveText("$14.12", { timeout: 2_000 });
        await expect(after.due).toHaveText("$14.13", { timeout: 2_000 });
        await expect(roundPayment(page, zh, 2)).toHaveText(text.paidRound, { timeout: 2_000 });
        await expect(roundPayment(page, zh, 1)).toHaveText(text.onBill);
        // Still offered: this phone's own dish.
        await expect(pay.getByRole("radio", { name: text.mine, exact: true })).toBeEnabled();
        await expectLayout(page, zh, width);
        await page.screenshot({
          path: `test-results/b51-total-after-other-part-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });
      });
    });
