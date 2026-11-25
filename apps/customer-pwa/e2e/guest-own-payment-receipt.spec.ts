import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 56 (v15 b55 live, guest-closed-bill-menu-cart, the fail item "Can the guest who paid part
// (B, C) see a record of their own payment"): a guest paid part of a table's bill on their phone
// (their own dish, L55 CB2 order 76; part 1 of staff's even split in 2, L55 CB3 order 80) and
// staff then closed the rest. The payer saw only the table's "Paid $14.13": no "you paid", no
// method, no receipt on any tab, and once the table was closed and cleaned, nothing at all. The
// table read, the table-payment reads (the bill and this phone's own payment) and, once the table
// closed, the visit restore are the real API handlers on a local server, answering v15's records;
// the cart's refusal, the menu and the storefront reads are synthetic, in the shapes v15 answered.
type Scenario =
  | "by-dish-written-off"
  | "half-split-written-off"
  | "half-split-open"
  | "whole-table-paid-online"
  | "by-dish-both-paid";
interface GuestBillHttp {
  readonly url: string;
  close(): Promise<void>;
}
let scenario: Scenario = "by-dish-written-off";
/** Which phone asks (the payer, or another guest at the table), and whether the table closed. */
let phone: {
  payer: boolean;
  tableClosed: boolean;
  refunds?: "None" | "Partial" | "Full" | "Eight";
} = {
  payer: true,
  tableClosed: false,
};
let api: GuestBillHttp;
test.beforeAll(async () => {
  // A variable path: the API's source is loaded at run time, outside this app's typecheck.
  const helper = "../../api/test-support/guest-bill-closed-by-staff-http.ts";
  const { startGuestBillHttp } = (await import(helper)) as {
    startGuestBillHttp(
      origin: string,
      scenario: () => Scenario,
      phone: () => {
        payer: boolean;
        tableClosed: boolean;
        refunds?: "None" | "Partial" | "Full" | "Eight";
      },
    ): Promise<GuestBillHttp>;
  };
  api = await startGuestBillHttp(
    "http://127.0.0.1",
    () => scenario,
    () => phone,
  );
});
test.afterAll(async () => api?.close());
test.beforeEach(({ context }) => routeStorefrontReads(context));
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
    if (phone.tableClosed) {
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
  // Batch 56: the guest's table-payment reads (the bill, and this phone's own payment) are the
  // real handler on the local server, with the value the page sends.
  await page.route("**/api/v1/dine-in/table-payment", async (route) => {
    const request = route.request();
    const response = await route.fetch({
      url: api.url + new URL(request.url()).pathname,
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        cookie: "__Host-bop-guest=" + "s".repeat(43),
        "x-csrf-token": request.headers()["x-csrf-token"] ?? "",
      },
    });
    await route.fulfill({ response });
  });
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
  if (!zh) return;
  // Batch 61 (Linux Chromium): wait for the language button before reading which one it is; a
  // slower page had not drawn it yet, and the test went on in English.
  await page
    .getByRole("button", { name: /^(切换到中文|Switch to English)$/u })
    .first()
    .waitFor();
  const toZh = page.getByRole("button", { name: "切换到中文" });
  if ((await toZh.count()) > 0) {
    await toZh.click();
    await page.getByRole("button", { name: "Switch to English" }).waitFor();
  }
}

/** Inside the gutter, no line of it cut off, and the page never scrolls sideways. */
async function expectInside(box: Locator, width: number) {
  const rect = await box.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect?.x ?? 0).toBeGreaterThanOrEqual(15);
  expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeLessThanOrEqual(width - 15);
  expect(
    await box.evaluate((element) =>
      [...element.querySelectorAll("p, a, h2, h3, dt, dd")].some(
        (line) => line.scrollWidth > line.clientWidth,
      ),
    ),
  ).toBe(false);
  expect(
    await box.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}
/** On the first screen with 40 px to spare below it (Linux fonts run wider, wrap more). */
async function expectOnFirstScreen(line: Locator) {
  const rect = await line.boundingBox();
  expect(rect).not.toBeNull();
  expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBeLessThanOrEqual(844 - 40);
}

function words(zh: boolean, item: Scenario) {
  return {
    receipt: zh ? "您的收据" : "Your receipt",
    // Batch 57 (v15 b56 live): one name for a guest's phone payment, on every receipt.
    youPaid: zh ? "您已在这部手机上在线付款 $14.13。" : "You paid $14.13 online on this phone.",
    covers:
      item === "by-dish-written-off"
        ? zh
          ? "您付款的菜品"
          : "The dishes you paid for"
        : zh
          ? "本桌账单共\u00a02\u00a0份，这是第\u00a01\u00a0份"
          : "Part 1 of 2 of your table’s bill",
    total: zh ? "您实付合计" : "Total paid by you",
    method: zh ? "付款方式手机在线付款" : "Paid byOnline by phone",
    only: zh
      ? "这张收据只包括您的付款。本桌账单的其余部分已由店员关闭，不向您收取。"
      : "This receipt is for your payment only. Staff closed the rest of your table’s bill; it is not charged to you.",
    // Never that the table paid in full, and never another guest's part.
    wrong: zh
      ? /已全部付清|已结清|谢谢光临|\$14\.12/u
      : /paid in full|bill is paid|Thank you|\$14\.12/u,
    link: zh ? "查看您的收据" : "See your receipt",
    // Batch 56 review: the table is still open after staff closed the rest (Menu, dish, Cart).
    openNotice: zh ? "店员已关闭本桌账单" : "Staff closed your table’s bill",
    billLink: zh ? "查看账单" : "See the bill",
    ended: zh
      ? "店员已关闭本桌账单：已付的款项不变，其余不向您收取。"
      : "Staff closed your table’s bill: what was paid stays paid, and the rest is not charged to you.",
    endedTitle: zh ? "这桌的用餐已结束" : "This table’s visit has ended",
    anyReceipt: zh ? /收据|您已在这部手机上/u : /receipt|You paid/iu,
  };
}

/** The payer's own receipt on Your table: what it paid for, how, and that it is theirs only. */
async function expectOwnReceipt(page: Page, zh: boolean, item: Scenario, width: number) {
  const text = words(zh, item);
  const receipt = page.getByRole("region", { name: text.receipt });
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText(text.youPaid);
  await expect(receipt.getByRole("heading", { name: text.covers })).toBeVisible();
  if (item === "by-dish-written-off") await expect(receipt).toContainText("Beef noodles (TEST)");
  await expect(receipt).toContainText(text.total + "$14.13");
  await expect(receipt).toContainText(text.method);
  await expect(receipt).toContainText(text.only);
  await expect(receipt).not.toContainText(text.wrong);
  // Batch 57 (v15 b56 live): the closing note is its own paragraph under the amounts, a section
  // gap (the page's 16 px token) below the last row, "Paid by", not a row of that table. Before,
  // it sat about 4 px under it.
  const paidBy = receipt.locator("dl > div").last();
  await expect(paidBy).toContainText(text.method);
  const below = await receipt.getByText(text.only).boundingBox();
  const row = await paidBy.boundingBox();
  expect((below?.y ?? 0) - ((row?.y ?? 0) + (row?.height ?? 0))).toBeGreaterThanOrEqual(12);
  await expectInside(receipt, width);
  await expectOnFirstScreen(receipt.getByText(text.youPaid));
}

const scenarios: readonly { readonly scenario: Scenario; readonly title: string }[] = [
  { scenario: "by-dish-written-off", title: "by dish, own dish paid (order 76)" },
  { scenario: "half-split-written-off", title: "split 1 of 2 paid (order 80)" },
];

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN the payer's own receipt after staff closed the rest (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });
      for (const item of scenarios) {
        test(`${item.title}: the payer keeps a receipt while open, after close and after cleaning`, async ({
          page,
        }) => {
          test.setTimeout(90_000);
          scenario = item.scenario;
          phone = { payer: true, tableClosed: false };
          await stubTable(page, []);
          const text = words(zh, item.scenario);
          const tag = `${item.scenario}-payer-${zh ? "zh" : "en"}-${width}`;

          // The table is still open: Your table holds this phone's own receipt.
          await open(page, "/dine-in/session", zh);
          await expectOwnReceipt(page, zh, item.scenario, width);
          await page.screenshot({ path: `test-results/b56-open-${tag}.png`, fullPage: true });

          // Batch 56 review: still open, the guest usually still at the table: Menu, a dish page
          // and Cart say what this phone paid too, and link to its receipt (not to "the bill").
          for (const [where, path] of [
            ["menu", "/menu"],
            ["dish", `/menu/items/${sellable}`],
            ["cart", "/cart"],
          ] as const) {
            await open(page, path, zh);
            const main = page.getByRole("main");
            await expect(main).toContainText(text.openNotice);
            await expect(main).toContainText(text.youPaid);
            const link = main.getByRole("link", { name: text.link });
            await expect(link).toHaveAttribute("href", "/dine-in/session");
            await expect(main.getByRole("link", { name: text.billLink })).toHaveCount(0);
            await expect(main).not.toContainText(text.wrong);
            await expectInside(main.getByText(text.youPaid), width);
            await expectOnFirstScreen(link);
            await page.screenshot({
              path: `test-results/b56-open-${where}-${tag}.png`,
              fullPage: true,
            });
          }
          await page.getByRole("main").getByRole("link", { name: text.link }).click();
          await expect(page).toHaveURL(/\/dine-in\/session$/u);
          await expectOwnReceipt(page, zh, item.scenario, width);

          // Staff closed and cleaned the table: every tab says what this phone paid, and the
          // others link to its receipt, which Your table still shows.
          phone = { payer: true, tableClosed: true };
          for (const [where, path] of [
            ["menu", "/menu"],
            ["dish", `/menu/items/${sellable}`],
            ["cart", "/cart"],
          ] as const) {
            await open(page, path, zh);
            const card = page.getByRole("main").getByRole("status").filter({ hasText: text.ended });
            await expect(card).toContainText(text.endedTitle);
            await expect(card).toContainText(text.youPaid);
            await expect(card.getByRole("link", { name: text.link })).toHaveAttribute(
              "href",
              "/dine-in/session",
            );
            await expect(page.getByRole("main")).not.toContainText(text.wrong);
            await expectInside(card, width);
            await expectOnFirstScreen(card.getByRole("link", { name: text.link }));
            await page.screenshot({
              path: `test-results/b56-closed-${where}-${tag}.png`,
              fullPage: true,
            });
          }
          await page.getByRole("main").getByRole("link", { name: text.link }).click();
          await expect(page).toHaveURL(/\/dine-in\/session$/u);
          await expect(page.getByRole("main").getByText(text.endedTitle)).toBeVisible();
          await expectOwnReceipt(page, zh, item.scenario, width);
          await expectNoInternalText(page);
          await page.screenshot({
            path: `test-results/b56-closed-table-${tag}.png`,
            fullPage: true,
          });
        });

        test(`${item.title}: another guest at the table sees no one's payment`, async ({
          page,
        }) => {
          test.setTimeout(90_000);
          scenario = item.scenario;
          phone = { payer: false, tableClosed: false };
          await stubTable(page, []);
          const text = words(zh, item.scenario);
          const tag = `${item.scenario}-other-${zh ? "zh" : "en"}-${width}`;
          await open(page, "/dine-in/session", zh);
          await expect(
            page.getByRole("region", { name: zh ? "本桌合计" : "Table total" }),
          ).toBeVisible();
          // Its own-payment read was answered "not found": nothing is shown for it.
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  performance
                    .getEntriesByType("resource")
                    .filter((entry) => entry.name.endsWith("/api/v1/dine-in/table-payment")).length,
              ),
            )
            .toBeGreaterThan(0);
          await expect(page.getByRole("region", { name: text.receipt })).toHaveCount(0);
          await expect(page.getByRole("main")).not.toContainText(text.anyReceipt);
          await page.screenshot({ path: `test-results/b56-open-${tag}.png`, fullPage: true });
          // Still open: Menu and Cart say how the bill ended and link to the bill, nothing more.
          for (const path of ["/menu", "/cart"]) {
            await open(page, path, zh);
            const main = page.getByRole("main");
            await expect(main).toContainText(text.openNotice);
            await expect(main.getByRole("link", { name: text.billLink })).toBeVisible();
            await expect(main).not.toContainText(text.anyReceipt);
          }
          phone = { payer: false, tableClosed: true };
          for (const path of ["/menu", "/cart", "/dine-in/session"]) {
            await open(page, path, zh);
            const card = page.getByRole("main").getByRole("status").filter({ hasText: text.ended });
            await expect(card).toBeVisible();
            await expect(card.getByRole("link")).toHaveCount(0);
            await expect(page.getByRole("main")).not.toContainText(text.anyReceipt);
          }
          await page.screenshot({
            path: `test-results/b56-closed-table-${tag}.png`,
            fullPage: true,
          });
        });
      }

      // Batch 57 (WP-2423 Q36, b56 remaining): staff refunded part of the payer's own phone
      // payment ($5.00 back, $3.00 on its way, $2.00 refused) or all of it. Before, the payer's
      // own receipt still said only "You paid $14.13 … Total paid by you $14.13". The own-payment
      // read and the restore are the real API handlers answering Payment's refund records.
      test("staff refunded the payer's own payment: each refund and the net, while open and after close", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        scenario = "half-split-written-off";
        phone = { payer: true, tableClosed: false, refunds: "Partial" };
        await stubTable(page, []);
        const tag = `refund-partial-${zh ? "zh" : "en"}-${width}`;
        // Batch 60 (v15 b59 live): what Payment confirmed went back ($5.00) is said as done, what
        // is still on its way ($3.00) as on its way.
        const youPaid = zh
          ? "您已在这部手机上在线付款 $14.13。$5.00 已退回您的卡，$3.00 正在退回，退回后您实付 $6.13。"
          : "You paid $14.13 online on this phone. $5.00 went back to your card and $3.00 is on its way, so in the end you pay $6.13.";
        const lines = zh
          ? [
              /，\$5\.00 已退回您的卡。银行可能要过几天才显示。$/u,
              /^\$3\.00 正在退回您的卡（.+ 发出），发卡银行还没有确认。$/u,
              /^.+ 发出的 \$2\.00 退款没有成功，没有钱退回您的卡。请找店员。$/u,
            ]
          : [
              /^On .+, \$5\.00 went back to your card\. Your bank may take a few days to show it\.$/u,
              /^\$3\.00 is on its way back to your card \(sent .+\)\. Your card issuer has not confirmed it yet\.$/u,
              /^A refund of \$2\.00 sent on .+ did not go through, so nothing went back to your card\. Please ask staff\.$/u,
            ];
        const expectRefunds = async () => {
          const receipt = page.getByRole("region", { name: zh ? "您的收据" : "Your receipt" });
          await expect(receipt).toContainText(youPaid);
          // Batch 58 (v15 b57 live): what was charged and what was paid after refunds, never two
          // amounts both called "paid by you" (zh 实付).
          await expect(receipt).toContainText((zh ? "付款金额" : "Amount charged") + "$14.13");
          await expect(receipt).toContainText(
            (zh ? "已退回您的卡" : "Refunded to your card") + "−$5.00",
          );
          await expect(receipt).toContainText(
            (zh ? "正在退回您的卡" : "On its way back to your card") + "−$3.00",
          );
          await expect(receipt).toContainText(
            (zh ? "退款后您实付" : "You paid after refunds") + "$6.13",
          );
          await expect(receipt).not.toContainText(
            zh ? /实付合计|退款后合计/u : /Total paid by you|Total after refunds/u,
          );
          const list = receipt.getByRole("list", {
            name: zh ? "您这笔付款的退款" : "Refunds of your payment",
          });
          const items = list.getByRole("listitem");
          await expect(items).toHaveCount(3);
          for (const [index, line] of lines.entries())
            expect(((await items.nth(index).textContent()) ?? "").replace(/\s+/gu, " ")).toMatch(
              line,
            );
          // Never the reason, who approved it, another guest's part or a reference.
          await expect(receipt).not.toContainText(
            zh ? /\$14\.12|食物|原因|re_/u : /\$14\.12|FOOD|reason|approved|re_/iu,
          );
          await expectInside(receipt, width);
          await expectOnFirstScreen(receipt.getByText(youPaid));
        };
        await open(page, "/dine-in/session", zh);
        await expectRefunds();
        await page.screenshot({ path: `test-results/b57-open-${tag}.png`, fullPage: true });
        // Menu and Cart say what the payer paid net, and link to the receipt.
        for (const path of ["/menu", "/cart"]) {
          await open(page, path, zh);
          const main = page.getByRole("main");
          await expect(main).toContainText(youPaid);
          await expectInside(main.getByText(youPaid), width);
          await expectOnFirstScreen(
            main.getByRole("link", { name: zh ? "查看您的收据" : "See your receipt" }),
          );
        }
        // The table closed and was cleaned: the restore and the receipt say the same.
        phone = { payer: true, tableClosed: true, refunds: "Partial" };
        await open(page, "/menu", zh);
        const card = page.getByRole("main").getByRole("status").filter({ hasText: youPaid });
        await expect(card).toBeVisible();
        await expectInside(card, width);
        await page.screenshot({ path: `test-results/b57-closed-menu-${tag}.png`, fullPage: true });
        await open(page, "/dine-in/session", zh);
        await expectRefunds();
        await expectNoInternalText(page);
        await page.screenshot({ path: `test-results/b57-closed-${tag}.png`, fullPage: true });
      });

      // Batch 58 (v15 b57 live, L57R A and L57R B): after staff refunded part 1's phone payment,
      // $8.00 of it or all of it, the shared Table total still said "Paid $14.13" on the payer's
      // phone and on another guest's. It is a table fact and must be true: what the table paid
      // after refunds, said as that, never who got what back. The table read is the real API.
      for (const refund of [
        { kind: "Partial", item: "half-split-written-off", net: "$6.13", back: "$8.00" },
        { kind: "Full", item: "by-dish-written-off", net: "$0.00", back: "$14.13" },
      ] as const)
        test(`staff refunded ${refund.kind === "Full" ? "all" : "part"} of a payment: the Table total says what the table paid after refunds, on every phone`, async ({
          page,
        }) => {
          test.setTimeout(90_000);
          scenario = refund.item;
          const label = zh ? "退款后已付" : "Paid after refunds";
          const gross = zh ? /已付款\$14\.13|已付\$14\.13/u : /Paid(?: so far)?\$14\.13/u;
          for (const payer of [true, false]) {
            phone = { payer, tableClosed: false, refunds: refund.kind };
            await stubTable(page, []);
            const tag = `table-refund-${refund.kind}-${payer ? "payer" : "other"}-${zh ? "zh" : "en"}-${width}`;
            await open(page, "/dine-in/session", zh);
            const total = page.getByRole("region", { name: zh ? "本桌合计" : "Table total" });
            await expect(total).toContainText(label + refund.net);
            await expect(total).not.toContainText(gross);
            // Never who was refunded or how much went back to anyone (batch 59: the table may say
            // that a part went back, never to whom).
            await expect(total).not.toContainText(
              zh ? /退回您|您的卡|退款\$/u : /back to|your card|Refunded\$/iu,
            );
            await expect(total).not.toContainText(refund.back);
            await expectInside(total, width);
            if (!payer) {
              // The other phone: no receipt, no refund, no one's payment anywhere on the page.
              await expect(page.getByRole("main")).not.toContainText(
                zh ? /收据|您已在这部手机上|退回您/u : /receipt|You paid|back to your card/iu,
              );
              // (A full refund's amount is also the paid round's own total on its card.)
              if (refund.kind === "Partial")
                await expect(page.getByRole("main")).not.toContainText(refund.back);
            }
            await page.screenshot({ path: `test-results/b58-open-${tag}.png`, fullPage: true });
            // Closed and cleaned: the ended page never states the gross as what was paid.
            phone = { payer, tableClosed: true, refunds: refund.kind };
            await open(page, "/dine-in/session", zh);
            await expect(
              page.getByRole("main").getByText(words(zh, refund.item).endedTitle),
            ).toBeVisible();
            await expect(page.getByRole("main")).not.toContainText(gross);
            await page.screenshot({ path: `test-results/b58-closed-${tag}.png`, fullPage: true });
          }
        });

      test("staff refunded all of the payer's dish: the receipt says all of it went back; another phone sees none of it", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        scenario = "by-dish-written-off";
        phone = { payer: true, tableClosed: true, refunds: "Full" };
        await stubTable(page, []);
        const tag = `refund-full-${zh ? "zh" : "en"}-${width}`;
        // Batch 60 (v15 b59 live, L59W A): Payment answered Succeeded, so it went back (已全部
        // 退回), never "goes back" (全部退回) beside the dated 已退回 line.
        const youPaid = zh
          ? "您已在这部手机上在线付款 $14.13。这笔款项已全部退回您的卡。"
          : "You paid $14.13 online on this phone. All of it went back to your card.";
        await open(page, "/dine-in/session", zh);
        const receipt = page.getByRole("region", { name: zh ? "您的收据" : "Your receipt" });
        await expect(receipt).toContainText(youPaid);
        await expect(receipt).toContainText((zh ? "付款金额" : "Amount charged") + "$14.13");
        await expect(receipt).toContainText(
          (zh ? "退款后您实付" : "You paid after refunds") + "$0.00",
        );
        await expect(receipt.getByRole("listitem")).toHaveCount(1);
        await expect(receipt).not.toContainText(
          zh ? /这笔款项全部退回|正在退回/u : /goes back|on its way/u,
        );
        await expectInside(receipt, width);
        await expectOnFirstScreen(receipt.getByText(youPaid));
        await page.screenshot({ path: `test-results/b57-closed-${tag}.png`, fullPage: true });
        for (const path of ["/cart", "/menu"]) {
          await open(page, path, zh);
          const card = page.getByRole("main").getByRole("status").filter({ hasText: youPaid });
          await expect(card).toBeVisible();
          await expectInside(card, width);
          await expectOnFirstScreen(card.getByText(youPaid));
        }
        await open(page, "/cart", zh);
        await expect(page.getByRole("main").getByRole("status")).toContainText(youPaid);
        // Another phone at the table: no one's payment and no refund. Batch 59: all that was
        // paid went back, so the ended page never says it stays paid.
        phone = { payer: false, tableClosed: true, refunds: "Full" };
        await open(page, "/dine-in/session", zh);
        await expect(
          page
            .getByRole("main")
            .getByRole("status")
            .filter({
              hasText: zh
                ? "店员已关闭本桌账单：已付的款项已全部退回，不向您收取。"
                : "Staff closed your table’s bill: what was paid went back in full; nothing is charged to you.",
            }),
        ).toBeVisible();
        await expect(page.getByRole("main")).not.toContainText(
          zh ? /已付的款项不变/u : /stays paid/u,
        );
        await expect(page.getByRole("main")).not.toContainText(
          zh ? /收据|您已在这部手机上|退回您/u : /receipt|You paid|back to your card/iu,
        );
      });

      // Batch 59 (v15 b58 live, L58R B order 23 and L58R A order 16): staff split the bill
      // evenly in 2, phone A paid part 1 ($14.13), staff closed the rest, then a manager gave
      // all of part 1 back to the card. Both phones read "Paid after refunds $0.00", yet the
      // note under it still said the table paid 1 of the 2 parts (这桌 2 份付了 1 份), each
      // round said 2 份付了 1 份，其余不向您收取, and once cleaned the ended page said what was
      // paid stays paid. A part given back in full is not paid; a part only partly given back
      // still is ($8.00 back: "Paid after refunds $6.13", 1 of 2 parts paid). The table read and
      // the visit restore are the real API handlers on a local server.
      for (const refund of [
        { kind: "Full", net: "$0.00" },
        { kind: "Partial", net: "$6.13" },
      ] as const)
        test(`b59: part 1 of 2 ${refund.kind === "Full" ? "refunded in full" : "partly refunded"}: what the table paid agrees with the figure, on every phone, open and cleaned`, async ({
          page,
        }) => {
          test.setTimeout(120_000);
          scenario = "half-split-written-off";
          const full = refund.kind === "Full";
          const note = full
            ? zh
              ? "店员已关闭本桌账单：这桌 2 份中有 1 份付款已全部退回，不向您收取。"
              : "Staff closed your table’s bill: payments for 1 of the 2 parts went back in full; nothing is charged to you."
            : zh
              ? "店员已关闭本桌账单：这桌 2 份付了 1 份，其余不向您收取。"
              : "Staff closed your table’s bill: the table paid 1 of the 2 parts, and the rest is not charged to you.";
          // Batch 60 (v15 b59 live, L59W A): equal parts pay no round, so neither round (phone B's
          // round 2 was never paid) claims a refund; the note says what went back.
          const roundPayment = full
            ? zh
              ? "不向您收取"
              : "Not charged to you"
            : zh
              ? "2\u00a0份付了 1\u00a0份，其余不向您收取"
              : "1 of 2 parts paid; the rest not charged to you";
          const notice = full
            ? zh
              ? "店员已关闭本桌账单：已付的款项已全部退回，不向您收取。如需再点，请找店员。"
              : "Staff closed your table’s bill: what was paid went back in full; nothing is charged to you. To order anything else, ask staff."
            : // Batch 61 (v15 b60 live, CRT60 D): part of it went back, so nothing "stays paid".
              zh
              ? "店员已关闭本桌账单。其余不向您收取。如需再点，请找店员。"
              : "Staff closed your table’s bill. The rest is not charged to you. To order anything else, ask staff.";
          const ended = full
            ? zh
              ? "店员已关闭本桌账单：已付的款项已全部退回，不向您收取。"
              : "Staff closed your table’s bill: what was paid went back in full; nothing is charged to you."
            : zh
              ? "店员已关闭本桌账单。其余不向您收取。"
              : "Staff closed your table’s bill. The rest is not charged to you.";
          // What a fully refunded part must never be called.
          const paidPart = zh
            ? /2\s?份付了\s?1\s?份|已付的款项不变/u
            : /paid 1 of the 2 parts|1 of 2 parts paid|stays paid/u;
          for (const payer of [true, false]) {
            const tag = `b59-${refund.kind}-${payer ? "payer" : "other"}-${zh ? "zh" : "en"}-${width}`;
            // The bill closed by staff, the table still open.
            phone = { payer, tableClosed: false, refunds: refund.kind };
            await stubTable(page, []);
            await open(page, "/dine-in/session", zh);
            const total = page.getByRole("region", { name: zh ? "本桌合计" : "Table total" });
            await expect(total).toContainText(
              (zh ? "退款后已付" : "Paid after refunds") + refund.net,
            );
            await expect(total).toContainText(note);
            await expect(total).toContainText(
              (full ? (zh ? "账单" : "The bill") : zh ? "其余账款" : "Rest of the bill") +
                (zh ? "不向您收取" : "Not charged to you"),
            );
            if (full) await expect(total).not.toContainText(paidPart);
            // Never who was refunded or how much went back to anyone.
            await expect(total).not.toContainText(zh ? /您的卡|\$8\.00/u : /your card|\$8\.00/iu);
            await expectInside(total, width);
            const payments = (
              await page
                .locator(".dining-session__round-facts div")
                .filter({
                  has: page.locator("dt", {
                    hasText: new RegExp(`^${zh ? "付款" : "Payment"}$`, "u"),
                  }),
                })
                .locator("dd")
                .allTextContents()
            ).map((text) => text.trim());
            expect(payments).toEqual([roundPayment, roundPayment]);
            if (full)
              await expect(page.locator(".order-status__batches")).not.toContainText(
                zh ? /退回/u : /Refunded|went back/u,
              );
            await expectInside(page.locator(".order-status__batches"), width);
            if (!payer)
              await expect(page.getByRole("main")).not.toContainText(
                zh ? /收据|您已在这部手机上|您的卡/u : /receipt|You paid|your card/iu,
              );
            await expectNoInternalText(page);
            await page.screenshot({ path: `test-results/${tag}-open.png`, fullPage: true });
            // Menu while the table is still open.
            await open(page, "/menu", zh);
            const menuNotice = page
              .getByRole("main")
              .getByRole("status")
              .filter({ hasText: notice });
            await expect(menuNotice).toBeVisible();
            await expectInside(menuNotice, width);
            await expectOnFirstScreen(menuNotice);
            if (full) await expect(page.getByRole("main")).not.toContainText(paidPart);
            await page.screenshot({ path: `test-results/${tag}-menu.png`, fullPage: true });
            // Closed and cleaned: the ended page never says what all went back stays paid.
            phone = { payer, tableClosed: true, refunds: refund.kind };
            await open(page, "/dine-in/session", zh);
            const endedCard = page.getByRole("main").getByRole("status").filter({ hasText: ended });
            await expect(endedCard).toBeVisible();
            if (full) await expect(endedCard).not.toContainText(paidPart);
            await expect(endedCard).not.toContainText(zh ? /已付的款项不变/u : /stays paid/u);
            await expectInside(endedCard, width);
            await expectOnFirstScreen(endedCard.getByText(ended));
            await page.screenshot({ path: `test-results/${tag}-cleaned.png`, fullPage: true });
          }
        });
    });

/** Batch 60: each round card's Payment cell, newest round first (as the page lists them). */
async function roundPayments(page: Page, zh: boolean) {
  const cells = page
    .locator(".dining-session__round-facts div")
    .filter({
      has: page.locator("dt", { hasText: new RegExp(`^${zh ? "付款" : "Payment"}$`, "u") }),
    })
    .locator("dd");
  // Both rounds drawn first (a slower machine reads the table a moment later).
  await expect(cells).toHaveCount(2);
  return (await cells.allTextContents()).map((text) => text.replace(/\s+/gu, " ").trim());
}

// Batch 60 (v15 b58/b59 known limit): guests paying by dish each pay their own rounds (v15: one
// settlement per guest, one line per round). After staff gave back all or some of phone A's
// payment (round 1), round 1 still said its round-level "Paid" / 已付款 beside "Paid after
// refunds". Each round now says its truth; the phone that paid reads what it paid for the round
// after refunds, another phone only that some or all of it went back. The table read (with
// Payment's settlement shapes through the real per-round mapping), the table-payment reads and
// the visit restore are the real API handlers on a local server.
for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN b60 a round paid by dish after staff's refund (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });
      const words = {
        full: zh ? "已全额退款" : "Refunded in full",
        fullClosed: zh ? "已全部退回，不向您收取" : "Refunded in full; not charged to you",
        partly: zh ? "部分退款" : "Partly refunded",
        partlyYours: zh
          ? "部分退款，退款后您实付 $6.13"
          : "Partly refunded; you paid $6.13 after refunds",
        paid: zh ? "已付款" : "Paid",
        notCharged: zh ? "不向您收取" : "Not charged to you",
        // What another phone must never read of A's payment.
        private: zh
          ? /\$6\.13|\$8\.00|\$5\.00|\$3\.00|退回您|您的卡/u
          : /\$6\.13|\$8\.00|\$5\.00|\$3\.00|your card/iu,
      };
      for (const refund of ["Full", "Partial"] as const)
        test(`both guests paid by dish, A's payment ${refund === "Full" ? "all" : "partly"} back: round 1 says it on each phone, round 2 stays paid`, async ({
          page,
        }) => {
          test.setTimeout(90_000);
          scenario = "by-dish-both-paid";
          for (const payer of [true, false]) {
            const tag = `b60-bydish-paid-${refund}-${payer ? "payer" : "other"}-${zh ? "zh" : "en"}-${width}`;
            phone = { payer, tableClosed: false, refunds: refund };
            await stubTable(page, []);
            await open(page, "/dine-in/session", zh);
            const total = page.getByRole("region", { name: zh ? "本桌合计" : "Table total" });
            await expect(total).toContainText(
              (zh ? "退款后已付" : "Paid after refunds") +
                (refund === "Full" ? "$14.12" : "$20.25"),
            );
            // Newest first: round 2 (B's, still paid), then round 1 (A's).
            expect(await roundPayments(page, zh)).toEqual([
              words.paid,
              refund === "Full" ? words.full : payer ? words.partlyYours : words.partly,
            ]);
            const rounds = page.locator(".order-status__batches");
            if (!payer) await expect(rounds).not.toContainText(words.private);
            await expectInside(rounds, width);
            await expectNoInternalText(page);
            await page.screenshot({ path: `test-results/${tag}.png`, fullPage: true });
          }
        });
      for (const refund of ["Full", "Partial"] as const)
        test(`A paid its dish, staff closed the rest, then ${refund === "Full" ? "all" : "part"} of it went back: rounds, Menu and the ended page`, async ({
          page,
        }) => {
          test.setTimeout(120_000);
          scenario = "by-dish-written-off";
          const full = refund === "Full";
          const youPaid = full
            ? zh
              ? "您已在这部手机上在线付款 $14.13。这笔款项已全部退回您的卡。"
              : "You paid $14.13 online on this phone. All of it went back to your card."
            : zh
              ? "您已在这部手机上在线付款 $14.13。$5.00 已退回您的卡，$3.00 正在退回，退回后您实付 $6.13。"
              : "You paid $14.13 online on this phone. $5.00 went back to your card and $3.00 is on its way, so in the end you pay $6.13.";
          for (const payer of [true, false]) {
            const tag = `b60-bydish-closed-${refund}-${payer ? "payer" : "other"}-${zh ? "zh" : "en"}-${width}`;
            phone = { payer, tableClosed: false, refunds: refund };
            await stubTable(page, []);
            await open(page, "/dine-in/session", zh);
            // Round 2 was never paid: not charged, never "refunded". Round 1: what went back.
            // Batch 61 (v15 b60 live, CRT60 D): never "Unpaid part" for a round nobody paid.
            expect(await roundPayments(page, zh)).toEqual([
              words.notCharged,
              full ? words.fullClosed : payer ? words.partlyYours : words.partly,
            ]);
            const rounds = page.locator(".order-status__batches");
            if (!payer) {
              await expect(rounds).not.toContainText(words.private);
              await expect(page.getByRole("main")).not.toContainText(
                zh ? /收据|您已在这部手机上|退回您/u : /receipt|You paid|back to your card/iu,
              );
            } else await expect(page.getByRole("main")).toContainText(youPaid);
            await expectInside(rounds, width);
            await expectNoInternalText(page);
            await page.screenshot({ path: `test-results/${tag}-open.png`, fullPage: true });
            // Menu: the payer's own line says the refund in the right tense.
            await open(page, "/menu", zh);
            if (payer) {
              const line = page.getByRole("main").getByRole("status").filter({ hasText: youPaid });
              await expect(line).toBeVisible();
              await expectInside(line, width);
              await expectOnFirstScreen(line.getByText(youPaid));
            } else
              await expect(page.getByRole("main")).not.toContainText(
                zh ? /您已在这部手机上|退回您/u : /You paid|your card/iu,
              );
            await page.screenshot({ path: `test-results/${tag}-menu.png`, fullPage: true });
            // Closed and cleaned: the ended page says the same.
            phone = { payer, tableClosed: true, refunds: refund };
            const ended = full
              ? zh
                ? "店员已关闭本桌账单：已付的款项已全部退回，不向您收取。"
                : "Staff closed your table’s bill: what was paid went back in full; nothing is charged to you."
              : // Batch 61: part of it went back, so nothing "stays paid".
                zh
                ? "店员已关闭本桌账单。其余不向您收取。"
                : "Staff closed your table’s bill. The rest is not charged to you.";
            await open(page, "/menu", zh);
            const endedCard = page.getByRole("main").getByRole("status").filter({ hasText: ended });
            await expect(endedCard).toBeVisible();
            if (payer) await expect(endedCard).toContainText(youPaid);
            else await expect(endedCard).not.toContainText(words.private);
            await expect(endedCard).not.toContainText(zh ? /这笔款项全部退回/u : /goes back/u);
            await expectInside(endedCard, width);
            await expectOnFirstScreen(endedCard.getByText(ended));
            await page.screenshot({ path: `test-results/${tag}-cleaned.png`, fullPage: true });
          }
        });
    });

// Batch 57 (v15 b56 live, payer-own-payment-record): the same phone payment was named two ways —
// the payer's own receipt said "Card on this phone" / 本机在线付款, while an ordinary table one phone
// paid in full (TM2 L56P D, order 101) still said 付款方式 客人手机刷卡 ("a card swipe on a guest's
// phone") on Your table, open and ended. It is an online payment from the guest's phone, never a
// card machine swipe: one name per language on every receipt. The table-payment reads (the pay
// panel's receipt; once closed, the settled receipt) are the real API handlers on a local server.
for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN one name for a guest's phone payment (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });
      test("whole table paid on one phone (order 101): open and ended receipts say how", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        scenario = "whole-table-paid-online";
        phone = { payer: false, tableClosed: false };
        await stubTable(page, []);
        const method = zh ? "付款方式手机在线付款" : "Paid byOnline by phone";
        const old = zh ? /刷卡/u : /Card on|guest’s phone/u;
        const tag = `whole-table-${zh ? "zh" : "en"}-${width}`;

        await open(page, "/dine-in/session", zh);
        const receipt = page.getByRole("region", { name: zh ? "收据" : "Receipt", exact: true });
        await expect(receipt).toContainText((zh ? "实付合计" : "Total paid") + "$28.25");
        await expect(receipt).toContainText(method);
        await expect(receipt).not.toContainText(old);
        await expectInside(receipt, width);
        await page.screenshot({ path: `test-results/b57-open-${tag}.png`, fullPage: true });

        phone = { payer: false, tableClosed: true };
        await open(page, "/dine-in/session", zh);
        const ended = page.getByRole("region", { name: zh ? "收据" : "Receipt", exact: true });
        await expect(ended).toContainText(zh ? "第 1 轮" : "Round 1");
        await expect(ended).toContainText(method);
        await expect(ended).not.toContainText(old);
        await expectInside(ended, width);
        await expectNoInternalText(page);
        await page.screenshot({ path: `test-results/b57-ended-${tag}.png`, fullPage: true });
      });

      // Batch 57 (v15 b56 live, split-round-labels-and-rounding-note): during an open even split
      // with part 1 paid, zh-Hans Your table said the same progress three ways — the round cards
      // "2 份付了 1 份", the pay panel "已付 1/2 份 · 还差 $14.12", the Table total note "这桌分成 2 份付款，
      // 已付 1 份". One phrasing across the page (English already says "1 of 2 parts paid").
      test("open even split, part 1 paid (order 88): parts paid said one way", async ({ page }) => {
        test.setTimeout(90_000);
        scenario = "half-split-open";
        phone = { payer: false, tableClosed: false };
        await stubTable(page, []);
        const parts = zh ? "2\u00a0份付了 1\u00a0份" : "1 of 2 parts paid";
        await open(page, "/dine-in/session", zh);
        const main = page.getByRole("main");
        const pay = main.getByRole("region", { name: zh ? "结账付款" : "Pay the bill" });
        await expect(pay).toContainText(parts + (zh ? " · 还差 $14.12" : " · $14.12 to go"));
        const rounds = main.getByRole("region", { name: zh ? "各轮点单" : "Rounds" });
        await expect(rounds.getByText(parts, { exact: true })).toHaveCount(2);
        const total = main.getByRole("region", { name: zh ? "本桌合计" : "Table total" });
        await expect(total).toContainText(parts);
        await expect(total).toContainText((zh ? "还剩" : "Still to pay") + "$14.12");
        // Never the fraction or another phrasing of the same progress.
        await expect(main).not.toContainText(zh ? /1\/2|已付 1 份|分成 2 份付款/u : /1\/2/u);
        await expectInside(pay, width);
        await expectInside(total, width);
        await page.screenshot({
          path: `test-results/b57-split-open-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });
      });
    });

/** Batch 61: the receipt's rows as "label amount", in order. */
async function receiptRows(region: Locator) {
  return (await region.locator("dl > div").allInnerTexts()).map((row) =>
    row.replace(/\s+/gu, " ").trim(),
  );
}

// Batch 61 (v15 b60 live, customer-round-refund-truth: CRT60 B order 46, C order 49, D order 51).
// By dish, phone A paid $14.13 and phone B $14.12 ("Only what I added"), then a manager refunded
// all ($14.13) or $8.00 of A. While the table was open the pay panel still said "Everything on the
// bill is paid (2 payments). Thank you!", A had no own receipt and no "went back to your card"
// line, and Menu's "See the receipt" opened Your table without one. Once closed and cleaned, the
// table receipt read 实付合计 $28.25 / 已退款 −$14.13 / 第 1 份 … $14.13 / 第 2 份 … $14.12 on both
// phones. On D (staff closed the rest, then $8.00 back) Menu and the ended page said what was paid
// "stays paid" beside "$8.00 went back to your card", and the never-paid round 2 read "Unpaid part
// not charged to you". The table read, the table-payment reads and the visit restore are the real
// API handlers on a local server answering Payment's records in v15's shapes.
for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN b61 refunds after a bill was paid or closed (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });
      const youPaid = (refund: "Full" | "Eight") =>
        refund === "Full"
          ? zh
            ? "您已在这部手机上在线付款 $14.13。这笔款项已全部退回您的卡。"
            : "You paid $14.13 online on this phone. All of it went back to your card."
          : zh
            ? "您已在这部手机上在线付款 $14.13。$8.00 已退回您的卡，您实付 $6.13。"
            : "You paid $14.13 online on this phone. $8.00 went back to your card, so you paid $6.13.";
      const bYouPaid = zh
        ? "您已在这部手机上在线付款 $14.12。"
        : "You paid $14.12 online on this phone.";
      const settled = zh
        ? "账单已结清（共 2 笔），之后店员办理了退款。"
        : "The bill is settled (2 payments). Staff have since made a refund.";
      const allPaid = zh
        ? "账单都已付清（共 2 笔），谢谢！"
        : "Everything on the bill is paid (2 payments). Thank you!";
      const menuNotice = zh
        ? "这桌账单已结清，之后店员办理了退款。如需再点，请找店员。"
        : "Your table’s bill is settled, and staff have since made a refund. To order anything else, ask staff.";
      const ownLink = zh ? "查看您的收据" : "See your receipt";
      const ownReceipt = zh ? "您的收据" : "Your receipt";

      for (const refund of ["Full", "Eight"] as const)
        test(`by dish paid in full, then ${refund === "Full" ? "all" : "$8.00"} of A back: each phone's receipt and refund, open and cleaned`, async ({
          page,
        }) => {
          test.setTimeout(150_000);
          scenario = "by-dish-both-paid";
          const back = refund === "Full" ? "$14.13" : "$8.00";
          const net = refund === "Full" ? "$14.12" : "$20.25";
          for (const payer of [true, false]) {
            const tag = `b61-bydish-paid-${refund}-${payer ? "A" : "B"}-${zh ? "zh" : "en"}-${width}`;
            const mine = payer ? youPaid(refund) : bYouPaid;
            // Never the other phone's own amount or refund as a line of this phone's receipt.
            const othersPart = payer ? /· \$14\.12/u : /\$14\.13|\$6\.13|退回您|your card/iu;
            phone = { payer, tableClosed: false, refunds: refund };
            await stubTable(page, []);
            await open(page, "/dine-in/session", zh);
            const pay = page.getByRole("region", { name: zh ? "结账付款" : "Pay the bill" });
            await expect(pay).toContainText(settled);
            await expect(pay).not.toContainText(allPaid);
            const receipt = page.getByRole("region", { name: ownReceipt });
            await expect(receipt).toContainText(mine);
            await expect(receipt).not.toContainText(othersPart);
            // The note under a part's receipt never says it is only part of a bill paid in full.
            await expect(receipt).not.toContainText(zh ? /只包括您的付款/u : /payment only/u);
            await expectInside(receipt, width);
            await expectOnFirstScreen(pay.getByText(settled));
            await expectNoInternalText(page);
            await page.screenshot({ path: `test-results/${tag}-open.png`, fullPage: true });
            // Menu and Cart: settled with a refund, this phone's own line, and its receipt.
            for (const path of ["/menu", "/cart"]) {
              await open(page, path, zh);
              const main = page.getByRole("main");
              await expect(main).toContainText(menuNotice);
              await expect(main).toContainText(mine);
              await expect(main).not.toContainText(zh ? /这桌已结清。/u : /bill is paid\./u);
              const link = main.getByRole("link", { name: ownLink });
              await expectInside(main.getByText(mine), width);
              await expectOnFirstScreen(link);
              await page.screenshot({
                path: `test-results/${tag}-${path.slice(1)}.png`,
                fullPage: true,
              });
            }
            await page.getByRole("main").getByRole("link", { name: ownLink }).click();
            await expect(page).toHaveURL(/\/dine-in\/session$/u);
            await expect(page.getByRole("region", { name: ownReceipt })).toContainText(mine);

            // Closed and cleaned: the table receipt says what was paid, what went back and what
            // the table paid after refunds, and itemises only this phone's own part.
            phone = { payer, tableClosed: true, refunds: refund };
            await open(page, "/dine-in/session", zh);
            const table = page.getByRole("region", { name: zh ? "收据" : "Receipt", exact: true });
            await expect(table).toBeVisible();
            const rows = await receiptRows(table);
            expect(rows.slice(-(payer ? 7 : 5))).toEqual([
              (zh ? "已付款 " : "Paid ") + "$28.25",
              (zh ? "已退款 −" : "Refunded −") + back,
              (zh ? "退款后实付 " : "Total paid after refunds ") + net,
              (zh ? "付款笔数 " : "Number of payments ") + "2",
              (zh ? "您的付款 手机在线付款 · " : "Your payment Online by phone · ") +
                (payer ? "$14.13" : "$14.12"),
              ...(payer
                ? [
                    (zh ? "已退回您的卡 −" : "Refunded to your card −") + back,
                    (zh ? "退款后您实付 " : "You paid after refunds ") +
                      (refund === "Full" ? "$0.00" : "$6.13"),
                  ]
                : []),
            ]);
            await expect(table).not.toContainText(
              zh ? /实付合计|第\s?\d\s?份/u : /Total paid\b(?! after)|Part \d/u,
            );
            // The table's totals are shared; A's own part and refund are never B's lines.
            if (!payer)
              await expect(table).not.toContainText(/· \$14\.13|\$6\.13|your card|您的卡/u);
            await expectInside(table, width);
            await expectNoInternalText(page);
            await page.screenshot({ path: `test-results/${tag}-cleaned.png`, fullPage: true });
          }
        });

      test("by dish paid in full, nothing refunded: paid in full, no refund words", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        scenario = "by-dish-both-paid";
        phone = { payer: true, tableClosed: false, refunds: "None" };
        await stubTable(page, []);
        await open(page, "/dine-in/session", zh);
        const pay = page.getByRole("region", { name: zh ? "结账付款" : "Pay the bill" });
        await expect(pay).toContainText(allPaid);
        await expect(pay).not.toContainText(zh ? /退款/u : /refund/iu);
        await expect(page.getByRole("region", { name: ownReceipt })).toHaveCount(0);
        phone = { payer: true, tableClosed: true, refunds: "None" };
        await open(page, "/dine-in/session", zh);
        const table = page.getByRole("region", { name: zh ? "收据" : "Receipt", exact: true });
        await expect(table).toBeVisible();
        const rows = await receiptRows(table);
        expect(rows).toContain((zh ? "实付合计 " : "Total paid ") + "$28.25");
        expect(rows).toContain(
          (zh ? "您的付款 手机在线付款 · " : "Your payment Online by phone · ") + "$14.13",
        );
        await expect(table).not.toContainText(zh ? /退款|\$14\.12/u : /Refund|\$14\.12/u);
        await expectInside(table, width);
      });

      test("by dish, staff closed the rest, then $8.00 of A back (CRT60 D): nothing stays paid, the unpaid round is not charged", async ({
        page,
      }) => {
        test.setTimeout(120_000);
        scenario = "by-dish-written-off";
        const notice = zh
          ? "店员已关闭本桌账单。其余不向您收取。如需再点，请找店员。"
          : "Staff closed your table’s bill. The rest is not charged to you. To order anything else, ask staff.";
        const ended = zh
          ? "店员已关闭本桌账单。其余不向您收取。"
          : "Staff closed your table’s bill. The rest is not charged to you.";
        const staysPaid = zh ? /已付的款项不变|未付部分/u : /stays paid|Unpaid part/u;
        for (const payer of [true, false]) {
          const tag = `b61-bydish-closed-eight-${payer ? "A" : "B"}-${zh ? "zh" : "en"}-${width}`;
          phone = { payer, tableClosed: false, refunds: "Eight" };
          await stubTable(page, []);
          await open(page, "/dine-in/session", zh);
          expect(await roundPayments(page, zh)).toEqual([
            zh ? "不向您收取" : "Not charged to you",
            payer
              ? zh
                ? "部分退款，退款后您实付 $6.13"
                : "Partly refunded; you paid $6.13 after refunds"
              : zh
                ? "部分退款"
                : "Partly refunded",
          ]);
          await expect(page.getByRole("main")).not.toContainText(staysPaid);
          await expectInside(page.locator(".order-status__batches"), width);
          await page.screenshot({ path: `test-results/${tag}-open.png`, fullPage: true });
          for (const path of ["/menu", "/cart"]) {
            await open(page, path, zh);
            const main = page.getByRole("main");
            await expect(main).toContainText(notice);
            await expect(main).not.toContainText(staysPaid);
            if (payer) await expect(main).toContainText(youPaid("Eight"));
            else await expect(main).not.toContainText(/\$8\.00|\$6\.13|your card|您的卡/u);
            // Menu says it as one line; Cart as a heading and a line.
            const line = main
              .locator("p")
              .filter({
                hasText: zh
                  ? "其余不向您收取。如需再点，请找店员。"
                  : "The rest is not charged to you. To order anything else, ask staff.",
              })
              .first();
            await expectInside(line, width);
            await expectOnFirstScreen(line);
          }
          await page.screenshot({ path: `test-results/${tag}-menu.png`, fullPage: true });
          phone = { payer, tableClosed: true, refunds: "Eight" };
          for (const path of ["/menu", "/dine-in/session"]) {
            await open(page, path, zh);
            const card = page.getByRole("main").getByRole("status").filter({ hasText: ended });
            await expect(card).toBeVisible();
            await expect(page.getByRole("main")).not.toContainText(staysPaid);
            if (payer && path === "/menu") await expect(card).toContainText(youPaid("Eight"));
            await expectInside(card, width);
            await expectOnFirstScreen(card.getByText(ended));
          }
          await page.screenshot({ path: `test-results/${tag}-cleaned.png`, fullPage: true });
        }
      });
    });
