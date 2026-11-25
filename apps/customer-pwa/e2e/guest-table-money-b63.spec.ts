import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 63 (design review of v15 batch 62, bundle customer-table-money, F02-F06): the guest's
// pay section and the ended table's receipt, with the table read, the table-payment reads and the
// visit restore answered by the real API handlers on a local server (apps/api/test-support), in
// the shapes v15 answered TM2's TEST tables; the menu, the cart's refusal, the member offer and
// the storefront reads are synthetic.
//  - F02/F03 (D62B-01/04, Owner-approved Figma 51:223): after this phone paid part 1 of an even
//    split ($16.01 with a $1.88 tip), Pay the bill showed no "you paid", Part 2 and the earlier tip
//    were already chosen and a live Pay button waited; five stacked tip rows pushed Pay off the
//    first screen and no breakdown was given.
//  - F04 (D62B-02): the ended receipt left out quantities, and each round heading stuck to the
//    previous round (0 px above, 11 px below).
//  - F05 (D62B-03): no Store name, address or date on the dine-in receipt, and no print or save.
//  - F06 (D62B-08): a phone that paid both parts was asked "Which part did you pay?" for half the
//    points, "Your payment" was listed twice with no total, and the part options were 21 px tall.
type Scenario = "half-split-open" | "by-dish-both-paid";
interface Phone {
  payer: boolean;
  tableClosed: boolean;
  partOneTipMinor?: string;
  markEven?: boolean;
  bothMine?: boolean;
  merchant?: boolean;
}
interface GuestBillHttp {
  readonly url: string;
  close(): Promise<void>;
}
let scenario: Scenario = "half-split-open";
let phone: Phone = { payer: true, tableClosed: false };
let api: GuestBillHttp;
test.beforeAll(async () => {
  // A variable path: the API's source is loaded at run time, outside this app's typecheck.
  const helper = "../../api/test-support/guest-bill-closed-by-staff-http.ts";
  const { startGuestBillHttp } = (await import(helper)) as {
    startGuestBillHttp(
      origin: string,
      scenario: () => Scenario,
      phone: () => Phone,
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

const id = (n: number) => "0198b063-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);
const sellable = id(3);
const dish = "Beef noodles (TEST)";
const height = 844;
const accent = "rgb(31, 99, 224)";
const green = "rgb(78, 154, 92)";

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

/** The points offer as v15 answered it: both parts this phone's own, or none (paid nothing). */
async function offerPoints(page: Page, certain: boolean) {
  await page.route("**/bff/customer/member", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        offered: true,
        signedIn: false,
        messagesAvailable: true,
        rule: {
          earnPointsPerDollar: 15,
          redeemPointsPerDollar: 100,
          minimumRedemptionPoints: 300,
          redemptionIncrementPoints: 100,
          rewards: [],
        },
        claim: {
          until: "2026-11-25T22:51:00.000Z",
          parts: [
            { partNumber: 1, points: 187, certain },
            { partNumber: 2, points: 188, certain },
          ],
        },
      }),
    }),
  );
}

const rowsOf = async (region: Locator) =>
  (await region.locator("dl > div").allInnerTexts()).map((row) => row.replace(/\s+/gu, " ").trim());
const top = async (box: Locator) => (await box.boundingBox())?.y ?? -1;
const bottom = async (box: Locator) => {
  const rect = await box.boundingBox();
  return (rect?.y ?? 0) + (rect?.height ?? 0);
};

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN b63 paying a part and keeping the table receipt (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height }, hasTouch: width < 768, isMobile: width < 768 });
      const tag = (name: string) => `test-results/b63-${name}-${zh ? "zh" : "en"}-${width}.png`;

      test("after paying part 1: you paid first, nothing chosen, tips in one row, then You pay", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        scenario = "half-split-open";
        phone = { payer: true, tableClosed: false, partOneTipMinor: "188", markEven: true };
        await offerPoints(page, true);
        await stubTable(page, []);
        await open(page, "/dine-in/session", zh);
        const pay = page.getByRole("region", { name: zh ? "结账付款" : "Pay the bill" });
        // F02: what this phone paid comes first, as a green dot and dark words, with its lines.
        const youPaid = pay.locator(".dining-session__you-paid-line");
        await expect(youPaid).toHaveText(
          zh
            ? "您已付 $16.01（含小费 $1.88）· 手机在线付款"
            : "You paid $16.01 (tip $1.88) · Online by phone",
        );
        expect(
          await youPaid.evaluate(
            (element) => getComputedStyle(element, "::before").backgroundColor,
          ),
        ).toBe(green);
        await expect(pay.locator(".dining-session__you-paid")).toContainText(
          zh ? "您实付合计$16.01" : "Total paid by you$16.01",
        );
        const parts = pay.locator(".dining-session__parts");
        expect(await bottom(youPaid)).toBeLessThanOrEqual(await top(parts));
        // Each part as a dot and words; the paid one is this phone's.
        const part1 = parts.locator("label").nth(0);
        const part2 = parts.locator("label").nth(1);
        await expect(part1).toHaveText(
          zh ? "第 1 份 · $14.13 · 您已付" : "Part 1 · $14.13 · paid by you",
        );
        expect(
          await part1
            .locator(".dining-session__part-dot")
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toBe(green);
        // Nothing chosen for the guest: no part, no tip, and Pay waits.
        await expect(pay.getByRole("radio", { checked: true })).toHaveCount(0);
        const button = pay.locator(".dining-session__pay-button");
        await expect(button).toBeDisabled();
        await expect(button).toHaveText(zh ? "请选择您付哪一份" : "Choose the part you pay");
        await expect(pay.locator(".dining-session__you-pay")).toHaveCount(0);
        // F03: the tips are one row of 44 px options, with what a percentage is of.
        const options = pay.locator(".dining-session__tip-row label");
        await expect(options).toHaveText(
          zh ? ["不加小费", "10%", "15%", "18%", "其他"] : ["No tip", "10%", "15%", "18%", "Other"],
        );
        const boxes = await options.evaluateAll((labels) =>
          labels.map((label) => label.getBoundingClientRect().toJSON() as DOMRect),
        );
        for (const box of boxes) {
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(Math.abs(box.top - (boxes[0]?.top ?? 0))).toBeLessThanOrEqual(1);
          // Room for wider Linux fonts at the right edge.
          expect(box.right).toBeLessThanOrEqual(width - 15);
        }
        // Linux (DejaVu) runs about 10 % wider: the row still fits with 40 px to spare at 390.
        if (width === 390)
          expect((boxes.at(-1)?.right ?? 0) - (boxes[0]?.left ?? 0)).toBeLessThanOrEqual(
            width - 32 - 40,
          );
        // Batch 63 review: what a percentage is of is said once a part is chosen (that part's own
        // amount before tax), never the rest of the bill before then.
        await expect(pay.locator(".dining-session__tip-basis")).toHaveCount(0);
        // Batch 63 review (Figma 51:223): the parts are a tight list — 44 px rows, 4 px apart.
        const partBoxes = await parts
          .locator("label")
          .evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().toJSON()));
        for (const [index, box] of partBoxes.entries()) {
          expect(box.height).toBeGreaterThanOrEqual(44);
          if (index > 0)
            expect(box.top - (partBoxes[index - 1]?.bottom ?? 0)).toBeLessThanOrEqual(4.5);
        }
        await page.screenshot({ path: tag("pay-after-part1"), fullPage: true });

        // The guest chooses part 2, then 15 %: the frame's 已选 and outline, and You pay.
        await part2.click();
        await expect(pay.locator(".dining-session__tip-basis")).toHaveText(
          zh ? "按税前 $12.50 计算" : "Based on $12.50 before tax",
        );
        await expect(part2).toHaveAttribute("data-state", "Chosen");
        expect(await part2.evaluate((element) => getComputedStyle(element).color)).toBe(accent);
        await expect(part2).toContainText(zh ? "已选" : "chosen");
        await expect(button).toHaveText(zh ? "请选择小费后付款" : "Choose a tip to pay");
        const fifteen = options.nth(2);
        await fifteen.click();
        expect(await fifteen.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe(
          accent,
        );
        await expect(options.nth(1)).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
        const youPay = pay.locator(".dining-session__you-pay");
        expect(await rowsOf(youPay)).toEqual(
          zh
            ? ["第 2 份 $14.12", "小费 15% $1.88", "合计 $16.00"]
            : ["Part 2 $14.12", "Tip 15% $1.88", "Total $16.00"],
        );
        await expect(youPay.locator(".dining-session__you-pay-total")).toHaveCSS(
          "font-weight",
          "600",
        );
        await expect(button).toBeEnabled();
        await expect(button).toHaveText(zh ? "支付 $16.00" : "Pay $16.00");
        // You pay sits right above the one accent button.
        expect(await bottom(youPay)).toBeLessThanOrEqual(await top(button));
        expect(await top(button)).toBeGreaterThan(await bottom(options.nth(0)));
        await expectInside(pay, width);
        await expectNoInternalText(page);
        await page.screenshot({ path: tag("pay-part2-tip15"), fullPage: true });
      });

      test("ended: quantities, round spacing, who it is from, print, your payments and points", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        scenario = "by-dish-both-paid";
        phone = { payer: true, tableClosed: true, bothMine: true, merchant: true };
        await page.addInitScript(() => {
          (window as unknown as { printed: number }).printed = 0;
          window.print = () => {
            (window as unknown as { printed: number }).printed += 1;
          };
        });
        await offerPoints(page, true);
        await stubTable(page, []);
        await open(page, "/dine-in/session", zh);
        const receipt = page.getByRole("region", { name: zh ? "收据" : "Receipt", exact: true });
        await expect(receipt).toBeVisible();
        const rows = await rowsOf(receipt);
        // F04: how many of each dish, as the Rounds list says it.
        expect(rows.slice(0, 2)).toEqual([`1 × ${dish} $12.50`, `1 × ${dish} $12.50`]);
        // F04: each round heading has the same space above and below it.
        const rounds = receipt.locator(".dining-session__receipt-round");
        const firstList = rounds.nth(0).locator("dl");
        const second = rounds.nth(1).locator("h3");
        const secondList = rounds.nth(1).locator("dl");
        const above = (await top(second)) - (await bottom(firstList));
        const below = (await top(secondList)) - (await bottom(second));
        expect(above).toBeGreaterThanOrEqual(8);
        expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
        // F05: who it is from and when, as the pickup receipt says it.
        const merchant = receipt.locator(".dining-session__receipt-merchant");
        await expect(merchant).toContainText("Test Merchant 2 Main - not production");
        await expect(merchant).toContainText("100 Example Street (TEST)");
        await expect(merchant).toContainText("Exampleville, ON A1A 1A1");
        await expect(merchant).toContainText(zh ? /付款时间 2026/u : /Paid Nov 2[34], 2026/u);
        // F06: this phone's two parts under one heading, with what it paid in all.
        await expect(
          receipt.getByRole("heading", { name: zh ? "您的付款" : "Your payments" }),
        ).toBeVisible();
        expect(rows.slice(-3)).toEqual(
          zh
            ? [
                "第 1 份 · 手机在线付款 $14.13",
                "第 2 份 · 手机在线付款 $14.12",
                "您实付合计 $28.25",
              ]
            : [
                "Part 1 · Online by phone $14.13",
                "Part 2 · Online by phone $14.12",
                "Total paid by you $28.25",
              ],
        );
        expect(rows.filter((row) => row.startsWith(zh ? "您的付款 " : "Your payment "))).toEqual(
          [],
        );
        // F05: one accent text action keeps a copy (the browser's print, which also saves a PDF).
        const print = page.getByRole("button", {
          name: zh ? "打印或保存收据" : "Print or save receipt",
        });
        await expect(print).toBeVisible();
        expect(await print.evaluate((element) => getComputedStyle(element).color)).toBe(accent);
        expect((await print.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(await top(print)).toBeGreaterThanOrEqual(await bottom(receipt));
        await print.click();
        expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(
          1,
        );
        // Batch 63 review (F05): printed, only the receipt shows — however printing starts and
        // however long print() takes (iOS Safari does not wait in it), with nothing set around it.
        await page.emulateMedia({ media: "print" });
        const visibility = (locator: Locator) =>
          locator.evaluate((element) => getComputedStyle(element).visibility);
        const printed = page.locator(".dining-session__receipt--settled");
        expect(await visibility(printed)).toBe("visible");
        expect(await visibility(printed.locator("dl").first())).toBe("visible");
        expect(await visibility(page.locator("h1").first())).toBe("hidden");
        expect(await visibility(page.locator(".dining-session__receipt-print button"))).toBe(
          "hidden",
        );
        expect(await visibility(page.locator(".member-panel").first())).toBe("hidden");
        await page.emulateMedia({ media: "screen" });
        // F06: the points on both parts, offered once, never "which part".
        const points = page.getByRole("region", {
          name: zh
            ? "加入会员，您付的款可以积 375 分"
            : "Join and earn 375 points on what you paid",
        });
        await expect(points).toBeVisible();
        await expect(
          page.getByText(zh ? "您付的是哪一份？" : "Which part did you pay?"),
        ).toHaveCount(0);
        await expectInside(receipt, width);
        await expectNoInternalText(page);
        await page.screenshot({ path: tag("ended-receipt"), fullPage: true });
      });

      test("ended, this phone paid nothing: which part is asked with 44 px rows", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        scenario = "by-dish-both-paid";
        phone = { payer: true, tableClosed: true, merchant: true };
        await offerPoints(page, false);
        await stubTable(page, []);
        await open(page, "/dine-in/session", zh);
        const question = page.getByRole("group", {
          name: zh ? "您付的是哪一份？" : "Which part did you pay?",
        });
        await expect(question).toBeVisible();
        const labels = question.locator("label");
        await expect(labels).toHaveCount(2);
        for (const box of await labels.evaluateAll((all) =>
          all.map((label) => label.getBoundingClientRect().height),
        ))
          expect(box).toBeGreaterThanOrEqual(44);
        await page.screenshot({ path: tag("ended-which-part") });
      });
    });
