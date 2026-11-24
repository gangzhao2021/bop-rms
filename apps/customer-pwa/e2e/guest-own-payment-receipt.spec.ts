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
type Scenario = "by-dish-written-off" | "half-split-written-off";
interface GuestBillHttp {
  readonly url: string;
  close(): Promise<void>;
}
let scenario: Scenario = "by-dish-written-off";
/** Which phone asks (the payer, or another guest at the table), and whether the table closed. */
let phone = { payer: true, tableClosed: false };
let api: GuestBillHttp;
test.beforeAll(async () => {
  // A variable path: the API's source is loaded at run time, outside this app's typecheck.
  const helper = "../../api/test-support/guest-bill-closed-by-staff-http.ts";
  const { startGuestBillHttp } = (await import(helper)) as {
    startGuestBillHttp(
      origin: string,
      scenario: () => Scenario,
      phone: () => { payer: boolean; tableClosed: boolean },
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
  const toZh = page.getByRole("button", { name: "切换到中文" });
  if (zh && (await toZh.count()) > 0) await toZh.click();
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
    youPaid: zh ? "您已在这部手机上刷卡支付 $14.13。" : "You paid $14.13 by card on this phone.",
    covers:
      item === "by-dish-written-off"
        ? zh
          ? "您付款的菜品"
          : "The dishes you paid for"
        : zh
          ? "本桌账单共\u00a02\u00a0份，这是第\u00a01\u00a0份"
          : "Part 1 of 2 of your table’s bill",
    total: zh ? "您实付合计" : "Total paid by you",
    method: zh ? "本机刷卡" : "Card on this phone",
    only: zh
      ? "这张收据只包括您的付款。本桌账单的其余部分已由店员关闭，不向您收取。"
      : "This receipt is for your payment only. Staff closed the rest of your table’s bill; it is not charged to you.",
    // Never that the table paid in full, and never another guest's part.
    wrong: zh
      ? /已全部付清|已结清|谢谢光临|\$14\.12/u
      : /paid in full|bill is paid|Thank you|\$14\.12/u,
    link: zh ? "查看您的收据" : "See your receipt",
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
    });
