import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 54 (v15 b53 live, table-total-note-after-by-dish-pay): at TM2's L53 WO4 (TEST), order 52,
// guest A paid their own dish ($14.13 of $28.25) and staff then recorded "Guests left without
// paying the rest". Every guest phone then read "Paid $14.13 … The table paid in one payment." /
// 这桌已一笔付清。: the read built closedByStaff, but the HTTP reply dropped it, and the page's own
// tests passed on a mocked read. Here the table read is the real API: v15's facts for order 52
// composed by the real read and answered by the real HTTP app on a local server. Only the pay
// section (staff have closed it) and the storefront reads are synthetic.
type Scenario =
  "open-after-one-dish" | "by-dish-written-off" | "parts-written-off" | "nothing-paid-written-off";
interface GuestBillHttp {
  readonly url: string;
  close(): Promise<void>;
}
let scenario: Scenario = "open-after-one-dish";
let api: GuestBillHttp;
test.beforeAll(async () => {
  // A variable path: the API's source is loaded at run time, outside this app's typecheck.
  const helper = "../../api/test-support/guest-bill-closed-by-staff-http.ts";
  const { startGuestBillHttp } = (await import(helper)) as {
    startGuestBillHttp(origin: string, scenario: () => Scenario): Promise<GuestBillHttp>;
  };
  api = await startGuestBillHttp("http://127.0.0.1", () => scenario);
});
test.afterAll(async () => api?.close());
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });

const id = (n: number) => "0198b054-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const tableLabel = "L53 WO4 (TEST)";
const dish = "Beef noodles (TEST)";

/** The pay section: A's part paid and the rest owed, then closed by staff (it hides itself). */
function paymentView() {
  const open = scenario === "open-after-one-dish";
  return {
    schemaVersion: 1,
    payment: {
      refundedMinor: "0",
      tableLabel,
      checkingOut: true,
      rounds: [
        {
          roundNumber: 2,
          items: [{ displayName: dish, subtotalMinor: "1250" }],
          totalMinor: "1412",
        },
      ],
      owed: { subtotalMinor: "1250", taxMinor: "162", totalMinor: "1412", taxRoundingMinor: "0" },
      consistent: true,
      matchesOrderApartFromSplit: true,
      tips: { enabled: true, tierPercents: [10, 15, 18] },
      state: open ? "NotPaid" : "Closed",
      attempt: null,
      split: open
        ? {
            mode: "ByGuests",
            stale: false,
            paidInFull: false,
            paidParts: 1,
            remainingMinor: "1412",
            parts: [
              {
                partNumber: 1,
                amountMinor: "1413",
                subtotalMinor: "1250",
                dishes: [{ displayName: dish, quantity: 1, shared: false }],
                status: "Paid",
                byYou: true,
                tables: [],
                roundNumbers: [],
              },
            ],
          }
        : null,
      choices: open
        ? {
            defaultScope: "WholeTable",
            mine: null,
            addedAny: true,
            mineUnavailable: false,
            dishes: [
              {
                orderItemReference: id(0x41),
                displayName: dish,
                roundNumber: 2,
                mine: false,
                unitMinor: ["1412"],
                unitSubtotalMinor: ["1250"],
              },
            ],
            rounds: [
              { roundNumber: 1, restMinor: "0", restSubtotalMinor: "0" },
              { roundNumber: 2, restMinor: "1412", restSubtotalMinor: "1250" },
            ],
          }
        : null,
      receipt: null,
    },
  };
}

async function openTable(page: Page, zh: boolean) {
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
          brandDisplayName: "Test Merchant 2 - not production",
          storeDisplayName: "Test Merchant 2 Main - not production",
        },
        visit: { publicTableReference: id(5), joined: true },
      }),
    ),
  );
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, messages: [] })),
  );
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
  // Batch 56: this phone's own-payment read is "not found" (it paid nothing), as the API answers.
  await page.route("**/api/v1/dine-in/table-payment", (route) =>
    (route.request().postDataJSON() as { action?: unknown } | null)?.action === "OwnPayment"
      ? route.fulfill(json(404, { schemaVersion: 1, error: { code: "table_not_found" } }))
      : route.fulfill(json(200, paymentView())),
  );
  await page.route("**/api/v1/dine-in/staff-call", (route) =>
    route.fulfill(
      json(409, {
        schemaVersion: 1,
        error: {
          code: "dining_staff_call_not_offered",
          messageKey: "customer.dining.staff_call.not_offered",
        },
      }),
    ),
  );
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, invitation: { canInvite: false } })),
  );
  // The table read: answered by the real API on its local server (the guest's cookie and
  // same-origin request as the pilot's own origin sends them).
  await page.route("**/api/v1/dine-in/session**", async (route) => {
    const asked = new URL(route.request().url());
    const response = await route.fetch({
      url: api.url + asked.pathname + asked.search,
      headers: {
        "sec-fetch-site": "same-origin",
        cookie: "__Host-bop-guest=" + "s".repeat(43),
        "x-csrf-token": "d".repeat(43),
      },
    });
    await route.fulfill({ response });
  });
  await page.goto("/dine-in/session");
  const toZh = page.getByRole("button", { name: "切换到中文" });
  if (zh && (await toZh.count()) > 0) await toZh.click();
  await expect(page.getByRole("region", { name: zh ? "本桌合计" : "Table total" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

const summaryOf = (page: Page, zh: boolean) =>
  page.getByRole("region", { name: zh ? "本桌合计" : "Table total" });

/** The Table total's lines as label/amount pairs, top to bottom. */
const totalLines = (page: Page, zh: boolean) =>
  summaryOf(page, zh)
    .locator("dl > div, p.order-status__total")
    .evaluateAll((rows) =>
      rows.map((row) => [
        (row.firstElementChild?.textContent ?? "").trim(),
        (row.lastElementChild?.textContent ?? "").trim(),
      ]),
    );

/**
 * One amount column (right edges within 1 px), each label at least 40 px before its amount (room
 * for wider Linux fonts) on the same line, inside the gutter, and no sideways scroll.
 */
async function expectLayout(page: Page, zh: boolean, width: number) {
  const summary = summaryOf(page, zh);
  const rows = await summary.locator("dl > div, p.order-status__total").evaluateAll((all) =>
    all.map((row) => {
      const range = (node: Element) => {
        const r = document.createRange();
        r.selectNodeContents(node);
        return r.getBoundingClientRect();
      };
      const label = range(row.firstElementChild as Element);
      const amount = range(row.lastElementChild as Element);
      return {
        row: (row.textContent ?? "").trim(),
        right: amount.right,
        gap: amount.left - label.right,
        sameLine: Math.abs(amount.top - label.top) < 12,
      };
    }),
  );
  const right = rows[0]?.right ?? 0;
  for (const row of rows) {
    expect(Math.abs(row.right - right), row.row).toBeLessThanOrEqual(1);
    expect(row.gap, row.row).toBeGreaterThanOrEqual(40);
    expect(row.sameLine, row.row).toBe(true);
  }
  const box = await summary.boundingBox();
  expect(box?.x ?? 0).toBeGreaterThanOrEqual(15);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await expectNoInternalText(page);
}

function words(zh: boolean) {
  return {
    subtotal: zh ? "小计" : "Subtotal",
    tax: zh ? "税" : "Tax",
    total: zh ? "合计" : "Total",
    paid: zh ? "已付款" : "Paid",
    paidSoFar: zh ? "已付" : "Paid so far",
    stillToPay: zh ? "还剩" : "Still to pay",
    rest: zh ? "其余账款" : "Rest of the bill",
    bill: zh ? "账单" : "The bill",
    notCharged: zh ? "不向您收取" : "Not charged to you",
    paying: zh ? "这桌正在结账" : "Your table is paying the bill",
    orderMore: zh ? "继续从菜单点单" : "Order more from the menu",
    partNote: zh ? "这桌按菜付款，已付 1 笔。" : "The table is paying by dish; 1 paid so far.",
    byDishClosed: zh
      ? "店员已关闭本桌账单：这桌按菜付了 1 笔，其余不向您收取。"
      : "Staff closed your table’s bill: the table paid by dish (1 paid), and the rest is not charged to you.",
    partsClosed: zh
      ? "店员已关闭本桌账单：这桌 3 份付了 1 份，其余不向您收取。"
      : "Staff closed your table’s bill: the table paid 1 of the 3 parts, and the rest is not charged to you.",
    nothingClosed: zh
      ? "店员已关闭本桌账单，未收取任何费用。"
      : "Staff closed your table’s bill; nothing was charged.",
    // What v15 said (and anything else claiming the bill was paid in full).
    paidInFull: zh
      ? /一笔付清|付清|最后一起|结这张单/u
      : /in one payment|paid in full|once at the end/u,
  };
}

const bill = (zh: boolean) => [
  [words(zh).subtotal, "$25.00"],
  [words(zh).tax, "$3.25"],
  [words(zh).total, "$28.25"],
];

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN a bill staff closed after the guests left (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });
      const text = words(zh);
      const tag = `${zh ? "zh" : "en"}-${width}`;

      test("order 52: one dish paid by dish, then staff closed the rest: never paid in full", async ({
        page,
      }) => {
        test.setTimeout(60_000);
        scenario = "open-after-one-dish";
        await openTable(page, zh);
        const summary = summaryOf(page, zh);
        await expect
          .poll(() => totalLines(page, zh))
          .toEqual([...bill(zh), [text.paidSoFar, "$14.13"], [text.stillToPay, "$14.12"]]);
        await expect(summary).toContainText(text.partNote);
        // Staff record "Guests left without paying the rest"; the phone reads the table again.
        scenario = "by-dish-written-off";
        await page.reload();
        await expect
          .poll(() => totalLines(page, zh))
          .toEqual([...bill(zh), [text.paid, "$14.13"], [text.rest, text.notCharged]]);
        await expect(summary).toContainText(text.byDishClosed);
        await expect(summary).not.toContainText(text.paidInFull);
        await expect(page.getByRole("main")).not.toContainText(text.paidInFull);
        await expectLayout(page, zh, width);
        await page.screenshot({
          path: `test-results/b54-closed-by-dish-${tag}.png`,
          fullPage: true,
        });
      });

      test("staff's split, 1 of 3 parts paid, then closed: says 1 of 3 and the rest not charged", async ({
        page,
      }) => {
        scenario = "parts-written-off";
        await openTable(page, zh);
        const summary = summaryOf(page, zh);
        await expect
          .poll(() => totalLines(page, zh))
          .toEqual([...bill(zh), [text.paid, "$9.42"], [text.rest, text.notCharged]]);
        await expect(summary).toContainText(text.partsClosed);
        await expect(summary).not.toContainText(text.paidInFull);
        await expectLayout(page, zh, width);
        await page.screenshot({ path: `test-results/b54-closed-parts-${tag}.png`, fullPage: true });
      });

      test("the guests left before anyone paid: nothing was charged, never 'pays at the end'", async ({
        page,
      }) => {
        scenario = "nothing-paid-written-off";
        await openTable(page, zh);
        const summary = summaryOf(page, zh);
        await expect
          .poll(() => totalLines(page, zh))
          .toEqual([...bill(zh), [text.paid, "$0.00"], [text.bill, text.notCharged]]);
        await expect(summary).toContainText(text.nothingClosed);
        // Staff closed the bill: no "paying the bill, ask staff to add more", no menu link.
        await expect(page.getByRole("main")).not.toContainText(text.paying);
        await expect(page.getByRole("link", { name: text.orderMore })).toHaveCount(0);
        await expect(summary).not.toContainText(text.paidInFull);
        await expect(summary).not.toContainText(zh ? /最后结账|取整/u : /at the end|rounded/u);
        await expectLayout(page, zh, width);
        await page.screenshot({
          path: `test-results/b54-closed-nothing-paid-${tag}.png`,
          fullPage: true,
        });
      });
    });
