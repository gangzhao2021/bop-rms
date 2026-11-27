import { expect, test, type Page } from "@playwright/test";
import { settlementViewFixture } from "../src/settlement.fixtures.js";
import { tonightSummaryFixture } from "../src/tonight-summary.fixtures.js";
import {
  headers,
  id,
  inLanguage,
  navigation,
  quietFrame,
  scope,
  session,
  sizes,
  type Language,
} from "./merchant-shell-fixture";

/**
 * Batch 67 (polish, v15 b65/b66 live), measured at 390, 1024 and 1440 in English and Chinese with
 * room for Linux fonts (DejaVu Sans runs about 10% wider). Synthetic HTTP answers, TEST-only data:
 *  (21) Reports said "Matches the day-end settlement: Net taken $1,078.73, all payment methods
 *       together", but Settlement showed only per-method nets ($813.41 online, called "Net taken",
 *       $52.52 card machine, $212.80 cash). Settlement now shows one all-methods Net taken.
 *  (10) Reports' Stores tab: the Store names were muted grey at 1024/1440 (dark on a phone).
 *  (11) Stock counts: the Start count button sat on the "No counts yet" heading with no gap.
 */
const shots = process.env.B67_SHOTS;
const shoot = async (page: Page, name: string) => {
  if (shots !== undefined) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};
const noSideways = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

async function frame(
  page: Page,
  language: Language,
  stores: readonly Record<string, unknown>[] = [scope],
  extraNavigation: readonly Record<string, unknown>[] = [],
) {
  await inLanguage(page, language);
  await quietFrame(page);
  const base = session("2026-11-26");
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        ...base,
        workspace: {
          ...base.workspace,
          authorizedStores: stores,
          navigation: [...navigation, ...extraNavigation],
        },
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-11-26",
        startsAt: "2026-11-26T09:00:00.000Z",
        endsAt: "2026-11-27T09:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: "2026-11-26T20:00:00.000Z",
      },
    }),
  );
}

/* ---------- (21) Settlement: one Net taken for every payment method ---------- */

const cad = (count: number, amountMinor: string) => ({ count, amountMinor, currencyCode: "CAD" });
/** TM2 Nov 25 as v15 read it: online $813.41, card machine $52.52, cash $212.80 net. */
const nov25 = () => ({
  ...settlementViewFixture(),
  businessDate: "2026-11-25",
  window: {
    startsAt: "2026-11-25T09:00:00.000Z",
    endsAt: "2026-11-26T09:00:00.000Z",
    timeZone: "America/Toronto",
    status: "Closed",
  },
  captured: cad(63, "107421"),
  refunded: cad(23, "26080"),
  cardMachine: {
    taken: cad(4, "6019"),
    tipMinor: "0",
    recordedAfterOutageCount: 0,
    refunded: cad(3, "767"),
  },
  cash: {
    received: cad(15, "21945"),
    tipMinor: "0",
    roundingMinor: "18",
    refunded: cad(2, "665"),
    netMinor: "21280",
    recordedAfterOutageCount: 0,
  },
  reportsLeftOut: [{ channel: "Online", orderCount: 3, amountMinor: "4239", currencyCode: "CAD" }],
});

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    const zh = language === "zh-Hans";
    test(`@production B67 (21) Settlement shows the all-methods Net taken Reports names, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await frame(page, language);
      await page.route("**/merchant/settlement*", (route) =>
        route.fulfill({ headers, json: nov25() }),
      );
      await page.goto("/app/operations/payment-reconciliation");
      const all = page.locator(".settlement__all-methods");
      await expect(all.locator("h3")).toHaveText(zh ? "所有付款方式" : "All payment methods");
      await expect(all.locator(".overview-count__label")).toHaveText(zh ? "净实收" : "Net taken");
      await expect(all.locator(".overview-count__value")).toHaveText("$1,078.73");
      // One "Net taken" on the page: the online-only figure is "Online net".
      await expect(
        page.locator(".overview-count__label", { hasText: zh ? /^净实收$/u : /^Net taken$/u }),
      ).toHaveCount(1);
      const online = page.locator(".settlement__totals").first().locator(".overview-count__label");
      await expect(online.nth(2)).toHaveText(zh ? "线上净实收" : "Online net");
      // It is the sum under its three parts: after Cash.
      const layout = await page.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          return rect
            ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
            : null;
        };
        const value = document.querySelector(".settlement__all-methods .overview-count__value");
        const line = value ? Number.parseFloat(getComputedStyle(value).lineHeight) : 0;
        const note = document.querySelector(".settlement__all-methods p");
        return {
          all: box(".settlement__all-methods"),
          cash: box(".settlement__cash"),
          heading: box(".settlement__cash h3"),
          allHeading: box(".settlement__all-methods h3"),
          valueHeight: value?.getBoundingClientRect().height ?? 0,
          line,
          noteOverflow: note ? note.scrollWidth - note.clientWidth : -1,
          window: window.innerWidth,
        };
      });
      expect(layout.all).not.toBeNull();
      expect(layout.all?.top ?? 0).toBeGreaterThanOrEqual(layout.cash?.bottom ?? 0);
      // Lined up with the other sections' headings, inside the window.
      expect(Math.abs((layout.allHeading?.left ?? 0) - (layout.heading?.left ?? 0))).toBeLessThan(
        1,
      );
      expect(layout.all?.right ?? 0).toBeLessThanOrEqual(layout.window);
      // The figure stays on one line.
      expect(layout.valueHeight).toBeLessThanOrEqual(layout.line * 1.5);
      expect(layout.noteOverflow).toBeLessThanOrEqual(0);
      await noSideways(page);
      await all.scrollIntoViewIfNeeded();
      await shoot(page, `settlement-${language}-${width}`);
    });
  }

/* ---------- (10) Reports' Stores tab: Store names in the dark row text ---------- */

const second = { ...scope, storeLabel: "Test Merchant 2 North (TEST)", storeReference: id(98) };
async function reportsStores(page: Page, language: Language) {
  await frame(page, language, [scope, second]);
  const summary = tonightSummaryFixture();
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({ headers, json: summary }),
  );
  await page.route("**/merchant/reports/stores/*/tonight", (route) =>
    route.fulfill({ headers, json: summary }),
  );
  await page.goto("/app/reports/operations");
  await page.getByRole("button", { name: language === "en" ? "Stores" : "门店" }).click();
  await expect(page.locator(".brand-stores__table tbody tr")).toHaveCount(2);
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes)
    test(`@production B67 (10) Reports' Stores tab names each Store in dark row words, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await reportsStores(page, language);
      const colors = await page.evaluate(() => {
        const own = (node: Element | null) => (node ? getComputedStyle(node).color : "");
        return {
          names: [...document.querySelectorAll(".brand-stores__table tbody th[scope=row]")].map(
            own,
          ),
          total: own(document.querySelector(".brand-stores__table tfoot th[scope=row]")),
          figure: own(document.querySelector(".brand-stores__table tbody td")),
          note: own(document.querySelector(".brand-stores__table .brand-stores__note")),
          text: getComputedStyle(document.body).color,
        };
      });
      expect(colors.names).toHaveLength(2);
      // The names read as the row's words (like the figures beside them and the names on Orders).
      for (const name of colors.names) expect(name).toBe(colors.text);
      expect(colors.total).toBe(colors.text);
      expect(colors.figure).toBe(colors.text);
      // What is said under a name ("You are here", "3 of 3 stores") stays quiet.
      expect(colors.note).not.toBe(colors.text);
      await noSideways(page);
      await shoot(page, `stores-${language}-${width}`);
    });

/* ---------- (11) Stock counts: room between Start count and "No counts yet" ---------- */

async function stockCounts(page: Page, language: Language) {
  await frame(
    page,
    language,
    [scope],
    [
      {
        screenId: "INV-COUNT-LIST",
        label: "Stock counts",
        href: "/operations/inventory/counts",
        permission: "inventory.count.read",
      },
    ],
  );
  await page.route("**/merchant/supply/counts/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "INV-COUNT-LIST",
        sourceAsOf: "2026-11-26T01:26:00.000Z",
        viewer: id(50),
        permissions: { mayCreate: true, mayCount: true, mayApprove: true },
        varianceReasons: ["UNRECORDED_WASTE", "COUNTING_ERROR"],
        items: [],
        locations: [{ locationReference: id(31), code: "MAIN", name: "Main storage" }],
        staff: [{ actorReference: id(50), label: "You" }],
        people: [],
        hasMore: false,
        counts: [],
      },
    }),
  );
  await page.goto("/operations/inventory/counts");
  await expect(page.locator("main .screen-heading h2")).toBeVisible();
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes)
    test(`@production B67 (11) Stock counts keeps the section gap between Start count and No counts yet, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await stockCounts(page, language);
      const button = page.getByRole("button", {
        name: language === "en" ? "Start count" : "开始盘点",
      });
      const empty = page.getByRole("heading", {
        name: language === "en" ? "No counts yet" : "还没有盘点",
      });
      await expect(empty).toBeVisible();
      const gaps = await page.evaluate(() => {
        const form = document.querySelector("main form.detail-section");
        const button = form?.querySelector("button");
        const empty = form?.nextElementSibling;
        const heading = empty?.querySelector("h2, h3, h4, strong") ?? empty;
        const header = document.querySelector("main .screen-heading");
        const formTop = form?.getBoundingClientRect().top ?? 0;
        // Between the heading block and the form: the page's gap between sections.
        const shortage = form?.previousElementSibling;
        const above =
          shortage && shortage !== header && shortage.getBoundingClientRect().height > 0
            ? shortage
            : header;
        return {
          below:
            (heading?.getBoundingClientRect().top ?? 0) -
            (button?.getBoundingClientRect().bottom ?? 0),
          section: formTop - (above?.getBoundingClientRect().bottom ?? 0),
        };
      });
      // At least the gap the page keeps between its sections (v3: the same rhythm everywhere).
      expect(gaps.section).toBeGreaterThanOrEqual(16);
      expect(gaps.below).toBeGreaterThanOrEqual(gaps.section - 1);
      await expect(button).toBeVisible();
      await noSideways(page);
      await shoot(page, `counts-${language}-${width}`);
    });
