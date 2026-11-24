import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 55 (v15 b54 live, guest-bill-closed-by-staff): after staff closed a bill the guests left
// without paying in full, Your table said so, but Menu, dish pages and Cart said "Your table’s bill
// is paid … See the receipt" / 这桌已结清 — order 59 too, where nothing was paid. Round cards
// still said "On the table's bill" / 记入本桌账单, and with staff's even split round 1 read "Paid"
// as if that round was what part 1 paid. The table read here is the real API (the v15 b54 facts
// for orders 59, 55 and 67, composed by the real read and answered by the real HTTP app on a local
// server). The cart's refusal, the pay section (closed), the menu and the storefront reads are
// synthetic, in the shapes v15 answered.
//
// Batch 55 review: once staff then closed the table, the restore gave receipt access and every tab
// said "Thank you for dining with us … See the receipt" for a bill that has no receipt. After the
// close, the visit restore is the real HTTP handler on the same local server (session over, the
// bill's write-off in the v15 shape).
//
// Batch 56 (v15 b55 live, TM2 L55 CB3, orders 80 and 87): while the bill was still open with staff's
// even split of 2 and part 1 paid, round 1 read "Paid" and round 2 "On the table's bill"; once
// staff closed it, the Table total note still ended with the cash rounding line, which said only
// card (the guest paid by phone); and at 1440 the dish page's allergy block began 150 px left of
// the dish.
type Scenario =
  | "one-round-nothing-paid-written-off"
  | "by-dish-written-off"
  | "half-split-written-off"
  | "half-split-open"
  | "half-split-paid";
interface GuestBillHttp {
  readonly url: string;
  close(): Promise<void>;
}
let scenario: Scenario = "one-round-nothing-paid-written-off";
/** Staff closed the table after closing its bill (the guest's Session is over). */
let tableClosed = false;
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
test.beforeEach(({ context }) => {
  tableClosed = false;
  return routeStorefrontReads(context);
});
test.use({ serviceWorkers: "block" });

const id = (n: number) => "0198b055-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);
const sellable = id(3);
const dish = "Beef noodles (TEST)";

function menu(locale: string) {
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
      locale,
      name: "Synthetic menu",
      effectiveFrom: at,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(44),
          name: "Noodles",
          sellables: [
            {
              sellableReference: sellable,
              productVersionReference: id(45),
              name: dish,
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
              displayPrice: { status: "Available", amount: "12.50", currency: "CAD", reason: null },
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

async function stubTable(page: Page, asked: string[]) {
  const json = (status: number, body: unknown) => ({
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/(api|bff)\//u.test(path)) asked.push(`${request.method()} ${path}`);
  });
  await page.route("**/api/v1/customer/session/csrf", async (route) => {
    if (tableClosed) {
      // The real restore handler answers for the closed table.
      const response = await route.fetch({
        url: api.url + new URL(route.request().url()).pathname,
        headers: {
          "sec-fetch-site": "same-origin",
          "x-bop-session-bootstrap": "1",
          cookie: "__Host-bop-guest=" + "s".repeat(43),
        },
      });
      await route.fulfill({ response });
      return;
    }
    await route.fulfill(
      json(200, {
        schemaVersion: 1,
        csrfToken: "d".repeat(43),
        menuContext: {
          publicStoreReference: publicStore,
          channel: "DineIn",
          locale: "en-CA",
          brandDisplayName: "Test Merchant 2 - not production",
          storeDisplayName: "Test Merchant 2 Main - not production",
        },
        visit: { publicTableReference: id(5), joined: true },
      }),
    );
  });
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, messages: [] })),
  );
  await page.route(`**/api/v1/public/stores/${publicStore}/menu**`, (route) =>
    route.fulfill(
      json(200, menu(new URL(route.request().url()).searchParams.get("locale") ?? "en-CA")),
    ),
  );
  // v15 b54: after staff closed the bill and until the table is closed, the cart read and every
  // cart change answer 409 cart_table_checking_out.
  const checkingOut = json(409, {
    schemaVersion: 1,
    error: { code: "cart_table_checking_out", messageKey: "customer.cart.table_checking_out" },
  });
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) => route.fulfill(checkingOut));
  await page.route("**/api/v1/carts**", (route) => route.fulfill(checkingOut));
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
  // The pay section of a bill staff closed hides itself (state Closed, no receipt). Batch 56:
  // this phone paid nothing itself, so its own-payment read is "not found", as the API answers.
  await page.route("**/api/v1/dine-in/table-payment", (route) =>
    (route.request().postDataJSON() as { action?: unknown } | null)?.action === "OwnPayment"
      ? route.fulfill(json(404, { schemaVersion: 1, error: { code: "table_not_found" } }))
      : route.fulfill(
          json(200, {
            schemaVersion: 1,
            payment: {
              refundedMinor: "0",
              tableLabel: "L54 GB (TEST)",
              checkingOut: true,
              rounds: [],
              owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0", taxRoundingMinor: "0" },
              consistent: true,
              matchesOrderApartFromSplit: true,
              tips: { enabled: true, tierPercents: [10, 15, 18] },
              state: "Closed",
              attempt: null,
              split: null,
              choices: null,
              receipt: null,
            },
          }),
        ),
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
  // The table read: answered by the real API on its local server.
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
}

async function open(page: Page, path: string, zh: boolean) {
  await page.goto(path);
  const toZh = page.getByRole("button", { name: "切换到中文" });
  if (zh && (await toZh.count()) > 0) await toZh.click();
}

function words(zh: boolean, nothingPaid: boolean) {
  return {
    whole: nothingPaid
      ? zh
        ? "店员已关闭本桌账单，未收取任何费用。如需再点，请找店员。"
        : "Staff closed your table’s bill; nothing was charged. To order anything else, ask staff."
      : zh
        ? "店员已关闭本桌账单：已付的款项不变，其余不向您收取。如需再点，请找店员。"
        : "Staff closed your table’s bill: what was paid stays paid, and the rest is not charged to you. To order anything else, ask staff.",
    heading: zh ? "店员已关闭本桌账单" : "Staff closed your table’s bill",
    line: nothingPaid
      ? zh
        ? "未收取任何费用。如需再点，请找店员。"
        : "Nothing was charged. To order anything else, ask staff."
      : zh
        ? "已付的款项不变，其余不向您收取。如需再点，请找店员。"
        : "What was paid stays paid, and the rest is not charged to you. To order anything else, ask staff.",
    link: zh ? "查看账单" : "See the bill",
    // What v15 said on Menu and Cart: the bill paid, with its receipt.
    wrong: zh ? /已结清|付清|收据/u : /bill is paid|paid in full|See the receipt/u,
    tableTotal: zh ? "本桌合计" : "Table total",
    // Batch 55 review: after staff also closed the table.
    endedTitle: zh ? "这桌的用餐已结束" : "This table’s visit has ended",
    ended: nothingPaid
      ? zh
        ? "店员已关闭本桌账单，未收取任何费用。"
        : "Staff closed your table’s bill; nothing was charged."
      : zh
        ? "店员已关闭本桌账单：已付的款项不变，其余不向您收取。"
        : "Staff closed your table’s bill: what was paid stays paid, and the rest is not charged to you.",
    endedWrong: zh ? /谢谢光临|收据|已结清/u : /Thank you for dining|receipt|is paid/u,
    payment: zh ? "付款" : "Payment",
  };
}

/** Nothing offers to add a dish, nothing is an alert, and the page never scrolls sideways. */
async function expectNothingToAdd(page: Page) {
  await expect(page.getByRole("button", { name: /^Add |加入|^\+/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Add to cart|加入购物车/u })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await expectNoInternalText(page);
}

/**
 * Inside the gutter, on the first screen with 40 px to spare below it (Linux fonts run wider and
 * wrap to more lines), and no line of it cut off.
 */
async function expectFits(box: Locator, width: number) {
  const rect = await box.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect?.x ?? 0).toBeGreaterThanOrEqual(15);
  expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeLessThanOrEqual(width - 15);
  expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBeLessThanOrEqual(844 - 40);
  expect(
    await box.evaluate((element) =>
      [...element.querySelectorAll("p, a, h2")].some((line) => line.scrollWidth > line.clientWidth),
    ),
  ).toBe(false);
}

/**
 * Batch 56: the dish page has one left edge. The allergy block below a dish without a photo starts
 * where the dish does (at 1440 it started at x 240, the dish at x 390).
 */
async function expectOneLeftEdge(page: Page) {
  const dishEdge = (await page.locator(".sellable-detail").boundingBox())?.x;
  const helpEdge = (await page.locator("aside.menu-help").boundingBox())?.x;
  expect(dishEdge).toBeDefined();
  expect(Math.abs((helpEdge ?? -1000) - (dishEdge ?? 0))).toBeLessThanOrEqual(1);
}

/** The Table total's closing note. */
const tableTotalNote = (page: Page, zh: boolean) =>
  page
    .getByRole("region", { name: zh ? "本桌合计" : "Table total" })
    .locator("p")
    .last()
    .textContent();

/** Each round's Payment, round 1 first (the page lists the newest round first). */
async function roundPayments(page: Page, zh: boolean) {
  const label = words(zh, false).payment;
  return (
    await page
      .locator(".dining-session__round-facts div")
      .filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`, "u") }) })
      .locator("dd")
      .allTextContents()
  )
    .map((text) => text.trim())
    .reverse();
}

const cases: readonly {
  readonly scenario: Scenario;
  readonly title: string;
  readonly nothingPaid: boolean;
  readonly rounds: (zh: boolean) => readonly string[];
}[] = [
  {
    scenario: "one-round-nothing-paid-written-off",
    title: "order 59, nothing paid",
    nothingPaid: true,
    rounds: (zh) => [zh ? "不向您收取" : "Not charged to you"],
  },
  {
    scenario: "by-dish-written-off",
    title: "orders 52 and 55, one dish paid by dish",
    nothingPaid: false,
    rounds: (zh) =>
      zh ? ["已付款", "未付部分不向您收取"] : ["Paid", "Unpaid part not charged to you"],
  },
  {
    scenario: "half-split-written-off",
    title: "order 67, 1 of 2 equal parts paid",
    nothingPaid: false,
    rounds: (zh) =>
      zh
        ? ["2\u00a0份付了 1\u00a0份，其余不向您收取", "2\u00a0份付了 1\u00a0份，其余不向您收取"]
        : [
            "1 of 2 parts paid; the rest not charged to you",
            "1 of 2 parts paid; the rest not charged to you",
          ],
  },
];

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN Menu, dish page and Cart once staff closed the bill (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });
      for (const item of cases)
        test(`${item.title}: never "paid", no receipt, round cards not owed`, async ({ page }) => {
          test.setTimeout(90_000);
          scenario = item.scenario;
          const asked: string[] = [];
          await stubTable(page, asked);
          const text = words(zh, item.nothingPaid);
          const tag = `${item.scenario}-${zh ? "zh" : "en"}-${width}`;

          await open(page, "/menu", zh);
          const notice = page.getByRole("main").getByRole("status").filter({ hasText: text.whole });
          await expect(notice).toBeVisible();
          await expect(notice.getByRole("link", { name: text.link })).toHaveAttribute(
            "href",
            "/dine-in/session",
          );
          await expect(page.getByRole("main")).not.toContainText(text.wrong);
          await expectFits(notice, width);
          await expectNothingToAdd(page);
          await page.screenshot({ path: `test-results/b55-menu-${tag}.png`, fullPage: true });

          await open(page, `/menu/items/${sellable}`, zh);
          await expect(
            page.getByRole("main").getByRole("heading", { name: dish }).first(),
          ).toBeVisible();
          const dishNotice = page
            .getByRole("main")
            .getByRole("status")
            .filter({ hasText: text.whole });
          await expect(dishNotice).toBeVisible();
          await expect(dishNotice.getByRole("link", { name: text.link })).toBeVisible();
          await expect(page.getByRole("main")).not.toContainText(text.wrong);
          await expectFits(dishNotice, width);
          await expectOneLeftEdge(page);
          await expectNothingToAdd(page);
          await page.screenshot({ path: `test-results/b55-dish-${tag}.png`, fullPage: true });

          await open(page, "/cart", zh);
          const cart = page.getByRole("region", { name: text.heading });
          await expect(cart).toBeVisible();
          await expect(cart).toContainText(text.line);
          await expect(cart.getByRole("link", { name: text.link })).toHaveAttribute(
            "href",
            "/dine-in/session",
          );
          await expect(page.getByRole("main")).not.toContainText(text.wrong);
          await expect(cart.getByRole("button")).toHaveCount(0);
          await expectFits(cart, width);
          await expectNothingToAdd(page);
          await page.screenshot({ path: `test-results/b55-cart-${tag}.png`, fullPage: true });

          await open(page, "/dine-in/session", zh);
          await expect(page.getByRole("region", { name: text.tableTotal })).toBeVisible();
          await expect.poll(() => roundPayments(page, zh)).toEqual(item.rounds(zh));
          await expect(page.getByRole("main")).not.toContainText(
            zh ? /记入本桌账单|已结清|收据/u : /On the table's bill|bill is paid|receipt/u,
          );
          // Batch 56: nothing more will be collected, so no cash rounding line.
          expect(await tableTotalNote(page, zh)).toContain(text.heading);
          expect(await tableTotalNote(page, zh)).not.toMatch(/5 cents|rounded|取整/u);
          // Each round's Payment fits its column: no word cut off, no sideways scroll.
          expect(
            await page
              .locator(".dining-session__round-facts dd")
              .evaluateAll((all) => all.some((dd) => dd.scrollWidth > dd.clientWidth)),
          ).toBe(false);
          await expectNothingToAdd(page);
          await page.screenshot({ path: `test-results/b55-table-${tag}.png`, fullPage: true });

          // Batch 55 review: staff then close the table. Every tab says how the bill ended, in
          // the same words, with no receipt and nothing to follow.
          tableClosed = true;
          for (const [where, path] of [
            ["menu", "/menu"],
            ["dish", `/menu/items/${sellable}`],
            ["cart", "/cart"],
            ["table", "/dine-in/session"],
          ] as const) {
            await open(page, path, zh);
            const card = page.getByRole("main").getByRole("status").filter({ hasText: text.ended });
            await expect(card).toBeVisible();
            await expect(card).toContainText(text.endedTitle);
            await expect(card.getByRole("link")).toHaveCount(0);
            await expect(page.getByRole("main")).not.toContainText(text.endedWrong);
            await expectFits(card, width);
            await expectNothingToAdd(page);
            await page.screenshot({
              path: `test-results/b55-closed-${where}-${tag}.png`,
              fullPage: true,
            });
          }

          // Nothing was offered, so nothing was tapped: no cart was started or changed (the pay
          // section's own read is a POST).
          expect(asked.filter((line) => /^POST .*cart/u.test(line))).toEqual([]);
        });
    });

// Batch 56 (v15 b55 live, order 80): staff's even split while the bill is open. A part is a share
// of the whole bill and pays no round, so every round says how many parts are paid, and Paid once
// all are; the Table total note names card and phone, as the guest may pay either way.
const openSplitCases = [
  {
    scenario: "half-split-open",
    title: "order 80, 1 of 2 equal parts paid, bill open",
    rounds: (zh: boolean) =>
      zh
        ? ["2\u00a0份付了 1\u00a0份", "2\u00a0份付了 1\u00a0份"]
        : ["1 of 2 parts paid", "1 of 2 parts paid"],
    note: (zh: boolean) =>
      zh
        ? "这桌分份付款：2\u00a0份付了 1\u00a0份。在柜台付现金按 5 分取整，刷卡和手机付款不取整。"
        : "The table is paying the bill in parts: 1 of 2 parts paid. Cash at the counter is rounded to the nearest 5 cents; card and phone payments are not.",
  },
  {
    scenario: "half-split-paid",
    title: "both equal parts paid",
    rounds: (zh: boolean) => (zh ? ["已付款", "已付款"] : ["Paid", "Paid"]),
    note: (zh: boolean) =>
      zh
        ? "这桌已分 2 份付清。现金按 5 分取整，刷卡和手机付款不取整。"
        : "The table paid the bill in 2 parts. Cash is rounded to the nearest 5 cents; card and phone payments are not rounded.",
  },
] as const;

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN Your table while staff's equal parts are paid (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });
      for (const item of openSplitCases)
        test(`${item.title}: rounds say the parts, never one round paid`, async ({ page }) => {
          test.setTimeout(60_000);
          scenario = item.scenario;
          await stubTable(page, []);
          await open(page, "/dine-in/session", zh);
          await expect(
            page.getByRole("region", { name: zh ? "本桌合计" : "Table total" }),
          ).toBeVisible();
          await expect.poll(() => roundPayments(page, zh)).toEqual(item.rounds(zh));
          await expect(page.getByRole("main")).not.toContainText(
            zh ? /记入本桌账单|不向您收取/u : /On the table's bill|not charged to you/u,
          );
          expect(await tableTotalNote(page, zh)).toContain(item.note(zh));
          // Each round's Payment fits its column: no word cut off, no sideways scroll.
          expect(
            await page
              .locator(".dining-session__round-facts dd")
              .evaluateAll((all) => all.some((dd) => dd.scrollWidth > dd.clientWidth)),
          ).toBe(false);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            ),
          ).toBeLessThanOrEqual(0);
          await expectNoInternalText(page);
          await page.screenshot({
            path: `test-results/b56-table-${item.scenario}-${zh ? "zh" : "en"}-${width}.png`,
            fullPage: true,
          });
        });
    });
