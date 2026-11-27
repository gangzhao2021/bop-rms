import { expect, test, type Locator, type Page } from "@playwright/test";
import { settlementViewFixture } from "../src/settlement.fixtures.js";
import { storeReportsViewFixture } from "../src/store-reports.fixtures.js";
import {
  headers,
  inLanguage,
  quietFrame,
  session,
  sizes,
  type Language,
} from "./merchant-shell-fixture";

/**
 * Batch 66 (v15 b65 live, TM2, Nov 25 and 26). Synthetic Store; the server is answered in the
 * browser with the shapes seen live (TEST-only data):
 *  - Reports (Nov 25) said "Matches the day-end settlement: $1,353.85 collected, $275.12 refunded"
 *    above "Net taken … $1,311.46 taken − $232.73 refunded". What matches is Net taken; the
 *    settlement's taken and refunded include 3 orders ($42.39) the report lists apart.
 *  - Settlement (Nov 26) said "Reports … can be lower" on a day Reports left nothing out.
 * Measured at 390, 1024 and 1440 in English and Chinese, inside the page with Linux fonts.
 */
async function noSideways(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
}

/** A paragraph: nothing cut off or past its box, and its box inside the window. */
async function inside(line: Locator) {
  const found = await line.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = node.getBoundingClientRect();
    return {
      text: node.textContent ?? "",
      right: Math.max(...[...range.getClientRects()].map((r) => r.right)),
      box: box.right,
      left: box.left,
      overflow: (node as HTMLElement).scrollWidth - (node as HTMLElement).clientWidth,
      window: window.innerWidth,
    };
  });
  expect(found.overflow, found.text).toBeLessThanOrEqual(0);
  expect(found.right, found.text).toBeLessThanOrEqual(found.box + 0.5);
  expect(found.left, found.text).toBeGreaterThanOrEqual(0);
  expect(found.box, found.text).toBeLessThanOrEqual(found.window);
}

/** One closed business day; `leftOut` orders ($) taken and given back the same day, online. */
async function reports(page: Page, language: Language, leftOut: [number, string] | null) {
  await inLanguage(page, language);
  await quietFrame(page);
  await page.route("**/merchant/session", (route) =>
    route.fulfill({ headers, json: session("2026-10-14") }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-14",
        startsAt: "2026-10-14T08:00:00.000Z",
        endsAt: "2026-10-15T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: "2026-10-15T01:00:00.000Z",
      },
    }),
  );
  const view = storeReportsViewFixture() as {
    includesOpenDay: boolean;
    days: Record<string, unknown>[];
    summary: Record<string, unknown>;
    byChannel: Record<string, unknown>[];
  };
  view.includesOpenDay = false;
  view.days = view.days.map((day) => ({ ...day, status: "Closed" }));
  if (leftOut !== null) {
    view.summary.cancelledInFullCount = leftOut[0];
    view.summary.cancelledInFullMinor = leftOut[1];
    const online = view.byChannel.find((entry) => entry.channel === "Online");
    if (online === undefined) throw new Error("fixture has no Online row");
    online.cancelledInFullCount = leftOut[0];
    online.cancelledInFullMinor = leftOut[1];
  }
  await page.route("**/merchant/reports?*", (route) => route.fulfill({ headers, json: view }));
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.goto("/app/reports/operations");
  await page
    .getByRole("button", { name: language === "zh-Hans" ? "按时段报表" : "Sales by period" })
    .click();
  return page.locator(".store-reports__match");
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    const zh = language === "zh-Hans";
    test(`@production b66: Reports' match line names Net taken and the money Settlement also counts (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const match = await reports(page, language, [3, "4239"]);
      // The fixture: $50.97 taken, $19.22 refunded, Net taken $31.75 (all methods).
      await expect(match).toHaveText(
        zh
          ? "与日结一致：所有付款方式合计净实收 $31.75。结算还算进了当天收款又全部退回的 3 笔订单（$42.39），本报表把它们另外列出，所以结算的实收和退款都多 $42.39。"
          : "Matches the day-end settlement: Net taken $31.75, all payment methods together. Settlement also counts 3 orders ($42.39) taken and given back the same day, which this report lists apart, so its taken and refunded each read $42.39 more.",
      );
      // Never the settlement's own taken and refunded above a summary that differs from them.
      await expect(match).not.toContainText("$50.97");
      await expect(match).not.toContainText(zh ? "已收" : "collected");
      // The figure it names is the one shown below it.
      const net = page
        .locator(".store-reports__totals li")
        .filter({ hasText: zh ? "净实收" : "Net taken" });
      await expect(net.locator(".overview-count__value")).toHaveText("$31.75");
      const matchBox = await match.boundingBox();
      const netBox = await net.boundingBox();
      expect(matchBox?.y ?? 0).toBeLessThan(netBox?.y ?? 0);
      await inside(match);
      await noSideways(page);
      await match.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/b66-reports-match-left-out-${language}-${width}.png`,
      });
    });

    test(`@production b66: on a day nothing is left out, Reports says only Net taken matches and Settlement says nothing about Reports (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const match = await reports(page, language, null);
      await expect(match).toHaveText(
        zh
          ? "与日结一致：所有付款方式合计净实收 $31.75。"
          : "Matches the day-end settlement: Net taken $31.75, all payment methods together.",
      );
      await expect(page.locator(".store-reports__left-out")).toHaveCount(0);
      await inside(match);
      await noSideways(page);

      await page.route("**/merchant/settlement*", (route) =>
        route.fulfill({ headers, json: { ...settlementViewFixture(), reportsLeftOut: [] } }),
      );
      await page.goto("/app/operations/payment-reconciliation");
      await expect(page.locator(".settlement__totals").first()).toBeVisible();
      await expect(page.locator(".settlement__reports-gap")).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText(
        zh ? "报表把当天收款又全部退回" : "Reports lists",
      );
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b66-settlement-nothing-left-out-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b66: Settlement names what Reports lists apart, on the day it happens (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await reports(page, language, [3, "4239"]);
      await page.route("**/merchant/settlement*", (route) =>
        route.fulfill({
          headers,
          json: {
            ...settlementViewFixture(),
            reportsLeftOut: [
              { channel: "Online", orderCount: 3, amountMinor: "4239", currencyCode: "CAD" },
            ],
          },
        }),
      );
      await page.goto("/app/operations/payment-reconciliation");
      const gap = page.locator(".settlement__reports-gap");
      await expect(gap).toHaveText(
        zh
          ? "报表把当天收款又全部退回的 3 笔订单（$42.39）另外列出，所以报表的线上（客人手机）实收和退款都比这里少 $42.39。净实收相同。"
          : "Reports lists 3 orders ($42.39) taken and given back the same day apart, so its Online (guest's phone) taken and refunded each read $42.39 less than here. Net taken is the same.",
      );
      const totals = page.locator(".settlement__totals").first();
      const totalsBox = await totals.boundingBox();
      const gapBox = await gap.boundingBox();
      expect(gapBox?.y ?? 0).toBeGreaterThanOrEqual((totalsBox?.y ?? 0) + (totalsBox?.height ?? 0));
      await inside(gap);
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b66-settlement-left-out-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }
