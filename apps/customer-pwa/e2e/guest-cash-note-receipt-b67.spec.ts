import { expect, test, type Locator, type Page } from "@playwright/test";
import { json, money, stubTableGuest } from "./guest-v3-fixtures";
import { receipt } from "./receipt-fixture";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 67 (v15 batch 65 live check, polish backlog items 1 and 2), on the production PWA with
// synthetic HTTP answers in the shapes v15 sent. Measured at 390, 1024 and 1440 in English and
// Chinese with the machine's fonts (DejaVu on Linux CI):
//  - P65 B paid in cash ($14.13 + $0.02 = $14.15): the zh 390 table total broke the cash note as
//    "…现金按 5 | 分取整…", and the guest's row read "现金取整 $0.02" where staff read "+$0.02".
//  - The DEMO receipt's item list began about 100 px under "Paid" with no heading, so the items,
//    subtotal, tax, total and payment read as a block apart from the receipt.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });

async function chooseChinese(page: Page) {
  const button = page.getByRole("button", { name: /^(切换到中文|Switch to English)$/u }).first();
  await button.waitFor();
  const toZh = page.getByRole("button", { name: "切换到中文" });
  if ((await toZh.count()) > 0) await toZh.click();
  await expect(page.locator("html")).toHaveAttribute("lang", /^zh/u);
}

async function noSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

/** P65 B after staff took cash for the whole table: $14.13 on the bill, paid $14.13 + rounding. */
async function openCashPaidTable(page: Page, roundingMinor: string) {
  const paidMinor = String(1413 + Number(roundingMinor));
  await stubTableGuest(page, {
    session: (base) => ({
      ...base,
      summary: {
        paid: money(paidMinor),
        refunded: money("0"),
        refundPending: money("0"),
        due: money("0"),
        bill: {
          items: money("1250"),
          takenOff: money("0"),
          pointsUsed: money("0"),
          subtotal: money("1250"),
          tax: money("163"),
          total: money("1413"),
        },
        tableTip: money("0"),
        cashRounding: money(roundingMinor),
      },
    }),
  });
  await page.route("**/api/v1/dine-in/table-payment**", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        payment: {
          tableLabel: "P65 B (TEST)",
          checkingOut: false,
          rounds: [],
          owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
          consistent: true,
          tips: { enabled: true, tierPercents: [10, 15, 18] },
          state: "Paid",
          attempt: null,
          split: null,
          receipt: {
            method: "Cash",
            roundsMinor: "1413",
            pointsUsedMinor: "0",
            tipMinor: "0",
            roundingMinor,
            totalMinor: paidMinor,
            paidAt: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      }),
    ),
  );
  await page.goto("/dine-in/session");
}

/**
 * Widths (px) of the note's paragraph at which "5 分" / "5 cents" is split across two lines. The
 * paragraph is narrowed step by step so the check holds wherever the sentence happens to wrap
 * (another font, another table's words), not only at this viewport.
 */
function splitWidths(note: Locator) {
  return note.evaluate((paragraph) => {
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const pieces: Range[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (const match of text.matchAll(/5[\s\u00a0](?:分|cents)/gu)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        pieces.push(range);
      }
    }
    if (pieces.length === 0) return null;
    const element = paragraph as HTMLElement;
    const full = element.getBoundingClientRect().width;
    const widths: number[] = [];
    for (let width = Math.floor(full); width >= 120; width -= 1) {
      element.style.width = `${String(width)}px`;
      for (const range of pieces) {
        const tops = new Set(
          [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
        );
        if (tops.size > 1) widths.push(width);
      }
    }
    element.style.width = "";
    return widths;
  });
}

/** Every section of the receipt with a heading, in reading order, measured. */
function measureReceipt(page: Page) {
  return page.locator(".receipt-page__content").evaluate((content) => {
    const rows = (section: Element) =>
      [...section.querySelectorAll("p, li, dl > div, address")]
        .filter((element) => (element as HTMLElement).offsetParent !== null)
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.height > 0);
    return [...content.children]
      .filter((child) => child.tagName === "SECTION" && child.querySelector(":scope > h2"))
      .map((section) => {
        const heading = section.querySelector(":scope > h2") as HTMLElement;
        const css = getComputedStyle(heading);
        const box = heading.getBoundingClientRect();
        const lines = rows(section);
        return {
          className: section.className,
          heading: heading.textContent ?? "",
          labelledBy: section.getAttribute("aria-labelledby"),
          headingId: heading.id,
          size: css.fontSize,
          weight: css.fontWeight,
          color: css.color,
          visible: box.height > 0 && css.visibility !== "hidden" && !heading.matches(".sr-only"),
          top: box.top,
          left: box.left,
          bottom: box.bottom,
          firstRowTop: Math.min(...lines.map((line) => line.top)),
          lastRowBottom: Math.max(...lines.map((line) => line.bottom)),
        };
      });
  });
}

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production batch 67 cash note and receipt items (${zh ? "zh-Hans" : "en"} ${String(width)})`, () => {
      test.use({
        viewport: { width, height: width === 390 ? 844 : 900 },
        hasTouch: width < 1440,
        isMobile: width < 768,
        locale: zh ? "zh-CN" : "en-CA",
      });
      const shot = (name: string) =>
        `test-results/b67-${name}-${zh ? "zh" : "en"}-${String(width)}.png`;

      for (const [roundingMinor, shown] of [
        ["2", "+$0.02"],
        ["-3", "−$0.03"],
      ] as const)
        test(`table total: cash rounding ${shown} is signed as staff see it, and "5 ${zh ? "分" : "cents"}" stays on one line`, async ({
          page,
        }) => {
          await openCashPaidTable(page, roundingMinor);
          if (zh) await chooseChinese(page);
          const summary = page.locator(".dining-session__summary");
          const note = summary.locator("p").filter({ hasText: zh ? "现金按" : "Cash is rounded" });
          await expect(note).toHaveCount(1);
          await expect(note).toContainText(
            zh ? "这桌已在最后一起付清。" : "The table paid once at the end.",
          );
          // Every Cash rounding row the guest reads carries its sign, as staff's does.
          const rows = page
            .getByRole("main")
            .locator("dl > div")
            .filter({
              has: page.locator("dt", { hasText: zh ? /^现金取整$/u : /^Cash rounding$/u }),
            });
          expect(await rows.count()).toBeGreaterThanOrEqual(1);
          for (const row of await rows.all()) await expect(row.locator("dd")).toHaveText(shown);
          expect(await splitWidths(note)).toEqual([]);
          await noSidewaysScroll(page);
          await page.screenshot({
            path: shot(`table-cash-${roundingMinor === "2" ? "up" : "down"}`),
            fullPage: true,
          });
        });

      test("receipt: the items have the receipt's section heading and spacing", async ({
        page,
      }) => {
        await page.route("**/api/v1/customer/session/csrf", (route) =>
          route.fulfill(
            json(200, {
              schemaVersion: 1,
              csrfToken: "c".repeat(43),
              menuContext: {
                publicStoreReference: "018f8a49-0000-7000-8000-000000000006",
                channel: "Pickup",
                locale: "en-CA",
                brandDisplayName: "Synthetic Brand",
                storeDisplayName: "Synthetic Receipt Store",
              },
            }),
          ),
        );
        const answer = receipt(true);
        await page.route(/\/api\/v1\/orders\/[^/]+\/receipt(?:\?.*)?$/u, (route) =>
          route.fulfill(json(200, answer)),
        );
        await page.goto(`/orders/${answer.receipt.orderReference}/receipt`);
        if (zh) await chooseChinese(page);
        const items = page.getByRole("region", { name: zh ? "商品" : "Items" });
        await expect(items).toBeVisible();
        await expect(items.locator(".receipt-page__lines li").first()).toBeVisible();
        const sections = await measureReceipt(page);
        const merchant = sections.find((s) => s.className.includes("receipt-page__merchant"));
        const financial = sections.find((s) => s.className.includes("receipt-page__financial"));
        const history = sections.find((s) => s.className.includes("receipt-page__history"));
        expect(merchant && financial && history).toBeTruthy();
        if (!merchant || !financial || !history) return;
        // The items' heading is the receipt's ordinary section heading, and names the section.
        expect(history.visible).toBe(true);
        expect(history.labelledBy).toBe(history.headingId);
        expect({ size: history.size, weight: history.weight, color: history.color }).toEqual({
          size: financial.size,
          weight: financial.weight,
          color: financial.color,
        });
        expect(Math.abs(history.left - financial.left) < 1 || history.left < financial.left).toBe(
          true,
        );
        // The first line sits under its heading as Payment's first line does under its heading.
        expect(
          Math.abs(
            history.firstRowTop - history.bottom - (financial.firstRowTop - financial.bottom),
          ),
        ).toBeLessThanOrEqual(2);
        if (width < 768) {
          // One column: the step into the items is the receipt's step between sections, not
          // a second, larger gap (about 100 px under "Paid" before).
          const step = financial.top - merchant.lastRowBottom;
          expect(Math.abs(history.top - financial.lastRowBottom - step)).toBeLessThanOrEqual(2);
          expect(Math.abs(history.left - financial.left)).toBeLessThanOrEqual(1);
        } else {
          // Two columns: the items and Payment start on one heading line.
          expect(Math.abs(history.top - financial.top)).toBeLessThanOrEqual(1);
          expect(history.left).toBeLessThan(financial.left);
        }
        await noSidewaysScroll(page);
        await page.screenshot({ path: shot("receipt-items"), fullPage: true });
      });
    });
