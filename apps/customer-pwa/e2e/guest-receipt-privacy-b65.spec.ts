import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  v15PickupOrderReference,
  v15PickupStatusBody,
} from "../src/order-status/v15-pickup-status.fixture";
import { checkout } from "./checkout-privacy-fixture";
import { id, json, money, stubTableGuest } from "./guest-v3-fixtures";
import { receipt } from "./receipt-fixture";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 65 (v15 batch 64 live check, customer-v3-leftovers), on the production PWA with synthetic
// HTTP answers in the shapes v15 sent. Measured at 390, 1024 and 1440 in English and Chinese with
// the machine's fonts (DejaVu on Linux CI):
//  - The Privacy notice stood alone on its own line on the order page, underlined unlike the links
//    around it; on the zh 390 receipt it broke inside the word (隐 | 私声明).
//  - F13: after C64 A paid the whole table online, Your table still said how cash is rounded.
//  - The receipt's "Back to order status" and "Refresh receipt" sat 8 px apart vertically, and
//    Refresh was bold, set 4 px in.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });

const accent = "rgb(31, 99, 224)";
const noStore = { "cache-control": "no-store" };
const demoStore = "DEMO Café (test only)";

async function chooseChinese(page: Page) {
  const button = page.getByRole("button", { name: /^(切换到中文|Switch to English)$/u }).first();
  await button.waitFor();
  const toZh = page.getByRole("button", { name: "切换到中文" });
  if ((await toZh.count()) > 0) await toZh.click();
  await expect(page.locator("html")).toHaveAttribute("lang", /^zh/u);
}

/** The privacy link as a guest sees it: one unbroken piece of an underlined accent sentence end. */
async function expectPrivacyInSentence(link: Locator, zh: boolean, sentence: RegExp) {
  await expect(link).toHaveText(zh ? /^隐私声明/u : /^Privacy notice/u);
  const seen = await link.evaluate((element) => {
    const css = getComputedStyle(element);
    const words = document.createRange();
    words.selectNodeContents(element.firstChild as Node);
    const box = element.getBoundingClientRect();
    return {
      color: css.color,
      underline: css.textDecorationLine,
      weight: css.fontWeight,
      // Every line box of the words: more than one means the link was split across lines.
      lines: new Set([...words.getClientRects()].map((rect) => Math.round(rect.top))).size,
      width: box.width,
      height: box.height,
      paragraph: (element.closest("p")?.textContent ?? "").trim(),
    };
  });
  expect(seen).toMatchObject({ color: accent, underline: "underline", weight: "400", lines: 1 });
  expect(seen.width).toBeGreaterThanOrEqual(44);
  expect(seen.height).toBeGreaterThanOrEqual(44);
  expect(seen.paragraph).toMatch(sentence);
  // Wherever the sentence happens to wrap (another Store name, another font), the link's words
  // stay together: narrow the paragraph step by step and count the link's lines each time.
  const split = await link.evaluate((element) => {
    const paragraph = element.closest("p") as HTMLElement;
    const full = paragraph.getBoundingClientRect().width;
    const words = document.createRange();
    words.selectNodeContents(element.firstChild as Node);
    const widths: number[] = [];
    for (let width = Math.floor(full); width >= 160; width -= 2) {
      paragraph.style.width = `${String(width)}px`;
      const lines = new Set([...words.getClientRects()].map((rect) => Math.round(rect.top)));
      if (lines.size > 1) widths.push(width);
    }
    paragraph.style.width = "";
    return widths;
  });
  expect(split).toEqual([]);
}

/** The receipt's visit read (the receipt asks for a CSRF token before reading). */
async function openReceipt(page: Page) {
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        csrfToken: "c".repeat(43),
        menuContext: {
          publicStoreReference: id(6),
          channel: "Pickup",
          locale: "en-CA",
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: "Synthetic Receipt Store",
        },
      }),
    ),
  );
  const answer = receipt(true);
  // The DEMO Store's name, as on the v15 receipt where 隐私声明 broke at 390.
  for (const record of answer.receipt.records) record.snapshot.storeDisplayName = demoStore;
  await page.route(/\/api\/v1\/orders\/[^/]+\/receipt(?:\?.*)?$/u, (route) =>
    route.fulfill(json(200, answer)),
  );
  await page.goto(`/orders/${answer.receipt.orderReference}/receipt`);
}

async function noSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

const entryAnswer = {
  schemaVersion: 2,
  status: "Established",
  brandDisplayName: "Synthetic Brand",
  storeDisplayName: "Synthetic Status Store",
  publicStoreReference: id(6),
  publicTableReference: null,
  channel: "Pickup",
  operatingState: "Open",
  availableServiceModes: ["Pickup"],
  locale: "en-CA",
  csrfToken: "h".repeat(43),
};

/** A pickup guest's order page, with the Store's privacy notice on its contact details. */
async function openPickupStatus(page: Page) {
  const body = v15PickupStatusBody("ready") as unknown as {
    status: { sources: Record<string, unknown> };
  };
  body.status.sources.privacyNoticeUrl = "https://example.test/privacy";
  await page.route(/\/api\/v1\/orders\/[^/]+\/status(?:\?.*)?$/u, (route) =>
    route.fulfill({ json: body }),
  );
  await page.route(/\/api\/v1\/orders\/[^/]+\/pickup-code(?:\?.*)?$/u, (route) =>
    route.fulfill({ status: 503, headers: noStore, json: {} }),
  );
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: noStore,
      json: { ...entryAnswer, contextExpiresAt: new Date(Date.now() + 600_000).toISOString() },
    }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(page.locator(".bop-shell__header h1")).toHaveText("Synthetic Status Store");
  await page.evaluate((target) => {
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/orders/${v15PickupOrderReference}`);
}

/** C64 A after one phone paid the whole table online ($28.25, no tip, nothing rounded). */
async function openPaidTable(page: Page) {
  await stubTableGuest(page, {
    session: (base) => ({
      ...base,
      summary: {
        paid: money("2825"),
        refunded: money("0"),
        refundPending: money("0"),
        due: money("0"),
        tableTip: money("0"),
        cashRounding: money("0"),
      },
    }),
  });
  await page.route("**/api/v1/dine-in/table-payment**", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        payment: {
          tableLabel: "C64 A (TEST)",
          checkingOut: false,
          rounds: [],
          owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
          consistent: true,
          tips: { enabled: true, tierPercents: [10, 15, 18] },
          state: "Paid",
          attempt: null,
          split: null,
          receipt: {
            method: "Online",
            roundsMinor: "2825",
            pointsUsedMinor: "0",
            tipMinor: "0",
            roundingMinor: "0",
            totalMinor: "2825",
            paidAt: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      }),
    ),
  );
  await page.goto("/dine-in/session");
}

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production batch 65 receipt, privacy and table note (${zh ? "zh-Hans" : "en"} ${String(width)})`, () => {
      test.use({
        viewport: { width, height: width === 390 ? 844 : 900 },
        hasTouch: width < 1440,
        isMobile: width < 768,
        locale: zh ? "zh-CN" : "en-CA",
      });
      const shot = (name: string) =>
        `test-results/b65-${name}-${zh ? "zh" : "en"}-${String(width)}.png`;

      test("receipt: Back to order status and Refresh receipt are one row of accent words", async ({
        page,
      }) => {
        await openReceipt(page);
        if (zh) await chooseChinese(page);
        const back = page.locator(".receipt-page__toolbar a");
        const refresh = page.locator(".receipt-page__toolbar button");
        await expect(back).toHaveText(zh ? "返回订单状态" : "Back to order status");
        await expect(refresh).toBeEnabled();
        const measure = (target: Locator) =>
          target.evaluate((element) => {
            const css = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            const words = document.createRange();
            words.selectNodeContents(element);
            const text = words.getBoundingClientRect();
            return {
              color: css.color,
              weight: css.fontWeight,
              size: css.fontSize,
              top: box.top,
              left: box.left,
              height: box.height,
              width: box.width,
              textLeft: text.left,
              textBottom: text.bottom,
            };
          });
        const [a, b] = [await measure(back), await measure(refresh)];
        for (const control of [a, b]) {
          expect(control).toMatchObject({ color: accent, weight: "400", size: "16px" });
          expect(control.height).toBeGreaterThanOrEqual(44);
          expect(control.width).toBeGreaterThanOrEqual(44);
          // The words start at the tap's own edge (no inset box).
          expect(Math.abs(control.textLeft - control.left)).toBeLessThanOrEqual(1);
        }
        if (Math.abs(a.top - b.top) < a.height) {
          // One row: the same top and the same text baseline.
          expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(1);
          expect(Math.abs(a.textBottom - b.textBottom)).toBeLessThanOrEqual(1);
        } else {
          // Wrapped (narrow fonts): one under the other, starting on the same edge.
          expect(b.top).toBeGreaterThanOrEqual(a.top + a.height);
          expect(Math.abs(a.left - b.left)).toBeLessThanOrEqual(1);
        }
        await noSidewaysScroll(page);
        await page.screenshot({ path: shot("receipt-toolbar") });
      });

      test("receipt: Privacy notice ends its sentence and never breaks inside the word", async ({
        page,
      }) => {
        await openReceipt(page);
        if (zh) await chooseChinese(page);
        await expectPrivacyInSentence(
          page.locator(".receipt-page__privacy .privacy-notice-link"),
          zh,
          zh
            ? /^DEMO Café \(test only\) ?如何处理您的联系方式：隐私声明/u
            : /^How DEMO Café \(test only\) handles your contact details: Privacy notice/u,
        );
        await noSidewaysScroll(page);
        await page.screenshot({ path: shot("receipt-privacy"), fullPage: true });
      });

      test("order page: Privacy notice ends a sentence, as on the receipt", async ({ page }) => {
        await openPickupStatus(page);
        if (zh) await chooseChinese(page);
        const section = page.locator(".contact-details");
        await expectPrivacyInSentence(
          section.locator(".privacy-notice-link"),
          zh,
          zh
            ? /^Synthetic Status Store ?如何处理您的联系方式：隐私声明/u
            : /^How Synthetic Status Store handles your contact details: Privacy notice/u,
        );
        await noSidewaysScroll(page);
        await page.screenshot({ path: shot("status-privacy"), fullPage: true });
      });

      test.describe("checkout", () => {
        // The checkout fixture walks in from the English start page; Chinese is chosen there.
        test.use({ locale: "en-CA" });
        test("checkout: Privacy notice stays in one piece at the end of its hint", async ({
          page,
        }) => {
          await checkout(page, true);
          if (zh) await chooseChinese(page);
          await expectPrivacyInSentence(
            page.locator(".checkout-details-form__hint .privacy-notice-link"),
            zh,
            zh ? /隐私声明/u : /only to contact you about this order.*Privacy notice/u,
          );
          await noSidewaysScroll(page);
          await page.screenshot({ path: shot("checkout-privacy") });
        });
      });

      test("F13: a table paid online is not told how cash is rounded", async ({ page }) => {
        await openPaidTable(page);
        if (zh) await chooseChinese(page);
        const summary = page.locator(".dining-session__summary");
        await expect(summary).toContainText(
          zh ? "这桌已在最后一起付清。" : "The table paid once at the end.",
        );
        await expect(page.getByRole("main")).toContainText(zh ? "手机在线付款" : "Online by phone");
        await expect(summary).not.toContainText(zh ? "取整" : "rounded");
        await expect(page.getByRole("main")).not.toContainText(zh ? "现金按 5 分取整" : "Cash is");
        await noSidewaysScroll(page);
        await page.screenshot({ path: shot("table-paid-online"), fullPage: true });
      });
    });
