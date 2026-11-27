import { expect, test, type Locator, type Page } from "@playwright/test";
import { at, store, workItem } from "./kitchen-tm2-fixture";

/**
 * WP-2423 batch 64 (v15 batch 63 live, Test Merchant 2's kitchen display):
 * - at 390 x 844 the header stack (bar in four rows, the board's bar, the notice line, a centred
 *   black "Filters · Active work" and Needs attention) pushed the first ticket to y=486, and
 *   "Find an order" was not in the bar;
 * - offline, each dish's Finished was disabled but still drawn in the accent;
 * - the ticket's type was off the v3 scale (title 32/700, dishes 22/700, foot button 18).
 */
const accent = "rgb(31, 99, 224)";
const rect = (locator: Locator) =>
  locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
const middle = (b: { top: number; bottom: number }) => (b.top + b.bottom) / 2;
const font = (locator: Locator) =>
  locator.evaluate((node) => [getComputedStyle(node).fontSize, getComputedStyle(node).fontWeight]);

async function startIn(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      try {
        localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        /* English */
      }
    });
}

/** A counter order of two dishes (one ticket), as order 35 was at TM2. */
const counter = { orderNumber: "35", orderType: "Pickup", tableLabel: null, enteredByStaff: true };
const twoDishes = [
  workItem(60, { orderLabel: counter }),
  workItem(61, {
    orderLabel: counter,
    orderReference: workItem(60, {}).orderReference,
    ticketReference: workItem(60, {}).ticketReference,
  }),
];

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 64: the kitchen display's first ticket is on a phone's first screen, with Find an order in the bar (${language})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const zh = language === "zh-Hans";
    await page.clock.setFixedTime(new Date(at));
    await startIn(page, language);
    await store(page, "Named", { reworks: [], commands: [] }, { todays: twoDishes });
    await page.goto("/operations/kitchen");
    const first = page.locator(".kitchen-ticket").first();
    await expect(first).toBeVisible();
    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1440, 900],
    ] as const) {
      const where = `${language} ${width}`;
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${where}: no sideways scroll`,
      ).toBe(true);
      const ticket = await rect(first);
      // Was 486 at 390 (live) and 364 at 1024 before batch 63.
      expect(ticket.top, `${where}: first ticket near the top`).toBeLessThan(
        width === 390 ? 440 : 240,
      );
      // Its first dish and that dish's Finished are on the first screen, 40 px clear of the end.
      const dish = await rect(first.locator(".kitchen-work-item").first());
      expect(dish.bottom, `${where}: first dish on the first screen`).toBeLessThan(height - 40);
      // Find an order sits in the board's bar beside Refresh; no separate Filters button.
      const find = page.getByRole("button", {
        name: zh ? "查找订单" : "Find an order",
        exact: true,
      });
      const refresh = page.getByRole("button", { name: zh ? "刷新" : "Refresh", exact: true });
      await expect(find).toBeVisible();
      expect(
        Math.abs(middle(await rect(find)) - middle(await rect(refresh))),
        `${where}: Find an order on the Refresh row`,
      ).toBeLessThan(12);
      // On a phone, Filters is accent text on the Pause ordering line (no row of its own).
      const filters = page.locator(".kitchen-filter-toggle");
      if (width === 390) {
        const pause = page.getByRole("button", { name: zh ? "暂停点单" : "Pause ordering" });
        expect(
          Math.abs(middle(await rect(filters)) - middle(await rect(pause))),
          `${where}: Filters on the Pause line`,
        ).toBeLessThan(12);
        expect(await filters.evaluate((node) => getComputedStyle(node).color)).toBe(accent);
        expect(await filters.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
          "rgba(0, 0, 0, 0)",
        );
      } else await expect(filters).toBeHidden();
      // The bar's Hand over and the Store's name: each on one line, the switch top-right.
      const handover = page.locator(".kitchen-handover-button");
      const name = page.locator(".bop-shell__header h1");
      const language_ = page.locator(".bop-shell__header .language-switch");
      const [nameBox, switchBox, handoverBox] = await Promise.all([
        rect(name),
        rect(language_),
        rect(handover),
      ]);
      expect(switchBox.right, `${where}: switch at the right`).toBeGreaterThan(width - 60);
      expect(switchBox.top, `${where}: switch on the top row`).toBeLessThan(nameBox.bottom);
      expect(
        handoverBox.bottom - handoverBox.top,
        `${where}: Hand over 44 px`,
      ).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `test-results/b64-kds-${width}-${language}.png` });
    }
  });

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 64: ticket type is on the v3 scale (${language})`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(at));
    await startIn(page, language);
    await store(page, "Named", { reworks: [], commands: [] }, { todays: twoDishes });
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/operations/kitchen");
      const ticket = page.locator(".kitchen-ticket").first();
      await expect(ticket).toBeVisible();
      const where = `${language} ${width}`;
      expect(await font(ticket.locator(".kitchen-ticket__number")), `${where}: title`).toEqual([
        "28px",
        "600",
      ]);
      const dish = ticket.locator(".kitchen-work-item").first();
      expect(await font(dish.locator(".kitchen-work-item__summary h3")), `${where}: dish`).toEqual([
        "20px",
        "600",
      ]);
      expect(await font(dish.locator(".kitchen-work-item__count")), `${where}: count`).toEqual([
        "20px",
        "600",
      ]);
      expect(await font(dish.locator(".kitchen-work-item__actions button").first())).toEqual([
        "16px",
        "600",
      ]);
      expect(await font(ticket.locator(".kitchen-ticket__next")), `${where}: foot`).toEqual([
        "16px",
        "600",
      ]);
    }
  });

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 64: offline, a dish's Finished is drawn disabled, not in the accent (${language})`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const zh = language === "zh-Hans";
    await page.clock.setFixedTime(new Date(at));
    await page.setViewportSize({ width: 1024, height: 768 });
    await startIn(page, language);
    await store(page, "Named", { reworks: [], commands: [] }, { todays: twoDishes });
    await page.goto("/operations/kitchen");
    const ticket = page.locator(".kitchen-ticket").first();
    const finished = ticket.locator(".kitchen-work-item__actions button");
    await expect(finished).toHaveCount(2);
    expect(await finished.first().evaluate((node) => getComputedStyle(node).color)).toBe(accent);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    await expect(
      page.getByText(zh ? /^收不到新单 · /u : /^Can't receive new orders — offline/u),
    ).toBeVisible({ timeout: 30_000 });
    for (const index of [0, 1]) {
      const button = finished.nth(index);
      await expect(button).toBeDisabled();
      expect(await button.evaluate((node) => getComputedStyle(node).color)).not.toBe(accent);
    }
    // Drawn as the ticket's own disabled buttons are.
    const foot = ticket.locator(".kitchen-ticket__next");
    await expect(foot).toBeDisabled();
    expect(await finished.first().evaluate((node) => getComputedStyle(node).color)).toBe(
      await foot.evaluate((node) => getComputedStyle(node).color),
    );
    await page.screenshot({ path: `test-results/b64-kds-offline-${language}.png` });
    await context.setOffline(false);
  });
