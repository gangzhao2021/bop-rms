import { expect, test, type Locator, type Page } from "@playwright/test";
import { at, store, workItem } from "./kitchen-tm2-fixture";

/**
 * WP-2423 batch 63 (v15 batch 62 page design review, bundle F-merchant-counter-kitchen): Test
 * Merchant 2's kitchen display, with the sound off, Pause ordering and 53 tickets from earlier
 * days, as seen live.
 *
 * - F45 (Figma 55:115): before the first ticket came the bar, a divider, then "Sound is off",
 *   "Pause ordering" and "Needs attention" about 60 px apart: the first ticket started at y=364 of
 *   768 at 1024. The header is now three short lines and there is no rule above the tickets.
 * - F50: a counter ticket read a bare "91" over "Pickup"; every pickup ticket now reads
 *   "Pickup · Order 91" with "Counter" in grey under it where that matters.
 * - F49: the "Find an order" button opened "Filter Kitchen work" with Close, Find, Clear, Clear
 *   filters and Done, the disabled ones looking live; a finished order could not be found.
 * - F46: offline, an empty board said "Nothing to make right now" and nothing said what to do.
 */
const sizes = [
  [1024, 768],
  [1440, 900],
  [390, 844],
] as const;

const rect = (locator: Locator) =>
  locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
  });
const middle = (b: { top: number; bottom: number }) => (b.top + b.bottom) / 2;

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

/** Today: a counter order (entered by staff) and an app order, both to make. */
const todays = [
  workItem(60, {
    orderLabel: { orderNumber: "91", orderType: "Pickup", tableLabel: null, enteredByStaff: true },
  }),
  workItem(61, { orderLabel: { orderNumber: "8", orderType: "Pickup", tableLabel: null } }),
];

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 63 (F45, F50): the kitchen display's header is three short lines and every pickup ticket has one title (${language})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const zh = language === "zh-Hans";
    await page.clock.setFixedTime(new Date(at));
    await startIn(page, language);
    await store(page, "Named", { reworks: [], commands: [] }, { todays });
    await page.goto("/operations/kitchen");
    const heading = page.locator(".kitchen-board-heading");
    const counter = page
      .locator(".kitchen-ticket")
      .filter({ hasText: zh ? "自取 · 91 号单" : "Pickup · Order 91" });
    await expect(counter).toBeVisible();
    for (const [width, height] of sizes) {
      const where = `${language} ${width}`;
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${where}: no sideways scroll`,
      ).toBe(true);
      // The title at 28/600 and no divider under the header.
      expect(
        await heading
          .getByRole("heading", { name: zh ? "后厨" : "Kitchen", exact: true })
          .evaluate((node) => [getComputedStyle(node).fontSize, getComputedStyle(node).fontWeight]),
        `${where}: title 28/600`,
      ).toEqual(["28px", "600"]);
      expect(
        await heading.evaluate((node) => getComputedStyle(node).borderBottomWidth),
        `${where}: no divider`,
      ).toBe("0px");
      // The sound notice, its own Turn sound on and Pause ordering on one line.
      const sound = page.getByText(
        zh
          ? "声音已关闭，新订单在这块屏幕上不会响铃。"
          : "Sound is off. New orders will not ring on this screen.",
      );
      const turnOn = page.getByRole("button", { name: zh ? "打开声音" : "Turn sound on" });
      const pause = page.getByRole("button", { name: zh ? "暂停点单" : "Pause ordering" });
      const [soundBox, turnOnBox, pauseBox] = await Promise.all([
        rect(sound),
        rect(turnOn),
        rect(pause),
      ]);
      expect(turnOnBox.height, `${where}: 44 px target`).toBeGreaterThanOrEqual(44);
      if (width >= 1024) {
        for (const [name, b] of [
          ["Turn sound on", turnOnBox],
          ["Pause ordering", pauseBox],
        ] as const)
          expect(
            Math.abs(middle(b) - middle(soundBox)),
            `${where}: ${name} on the sound line`,
          ).toBeLessThan(12);
      }
      // Needs attention is one line that says it opens.
      const attention = page.locator(".kitchen-earlier-days > summary");
      expect(
        await attention
          .locator(".kitchen-earlier-days__view")
          .evaluate((node) => getComputedStyle(node, "::after").content),
      ).toBe(zh ? '"查看"' : '"View"');
      expect((await rect(attention)).height, `${where}: one line`).toBeLessThanOrEqual(
        width >= 1024 ? 48 : 72,
      );
      // The tickets start near the top, with no rule above them.
      const first = page.locator(".kitchen-ticket").first();
      const firstBox = await rect(first);
      const limit = width === 390 ? 530 : 240;
      expect(
        firstBox.top,
        `${where}: first ticket near the top (was 364 at 1024, 570 at 390)`,
      ).toBeLessThan(limit);
      expect(await first.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe("0px");
      // One title pattern: "Pickup · Order 91", one line; the counter said in grey under it.
      const title = counter.locator(".kitchen-ticket__number");
      await expect(title).toHaveText(zh ? "自取 · 91 号单" : "Pickup · Order 91");
      const lines = await title.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects().length;
      });
      expect(lines, `${where}: title on one line`).toBe(1);
      await expect(counter.locator(".kitchen-ticket__kind")).toHaveText(zh ? "柜台" : "Counter");
      await page.screenshot({ path: `test-results/b63-kds-${width}-${language}.png` });
    }
    // An app order has no source line; its title follows the same pattern.
    const app = page
      .locator(".kitchen-ticket")
      .filter({ hasText: zh ? "自取 · 8 号单" : "Pickup · Order 8" });
    await expect(app.locator(".kitchen-ticket__kind")).toBeHidden();
  });

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 63 (F49): Find an order is named as its button, has one Done and finds a finished order (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    await page.clock.setFixedTime(new Date(at));
    await page.setViewportSize({ width: 1024, height: 768 });
    await startIn(page, language);
    await store(page, "Named", { reworks: [], commands: [] });
    await page.goto("/operations/kitchen");
    await page
      .getByRole("button", { name: zh ? "查找订单" : "Find an order", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: zh ? "查找订单" : "Find an order" });
    await expect(dialog).toBeVisible();
    for (const name of zh
      ? ["查找", "清除", "关闭", "清除筛选"]
      : ["Find", "Clear", "Close", "Clear filters"])
      await expect(dialog.getByRole("button", { name, exact: true }), `no ${name}`).toHaveCount(0);
    const done = dialog.getByRole("button", { name: zh ? "完成" : "Done" });
    expect(await done.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      "rgb(31, 99, 224)",
    );
    // Order 6 was finished a minute ago: typing its number finds it, whatever the state chosen.
    await dialog.getByRole("searchbox").fill("6");
    await done.click();
    await expect(
      page
        .locator(".kitchen-ticket")
        .filter({ hasText: zh ? "自取 · 6 号单" : "Pickup · Order 6" }),
    ).toBeVisible();
  });

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 63 (F46): offline, an empty board says new orders can't arrive and what to do, never that there is nothing to make (${language})`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const zh = language === "zh-Hans";
    await page.clock.setFixedTime(new Date(at));
    await page.setViewportSize({ width: 1024, height: 768 });
    await startIn(page, language);
    await store(page, "Named", { reworks: [], commands: [] }, { todays: [], finished: [] });
    await page.goto("/operations/kitchen");
    await expect(page.getByText(zh ? "没有进行中的工作" : "No active work")).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    const line = page.getByText(
      zh
        ? /^收不到新单 · \d\d:\d\d 起断网$/u
        : /^Can't receive new orders — offline since \d\d:\d\d$/u,
    );
    await expect(line).toBeVisible({ timeout: 30_000 });
    expect(
      await line.evaluate((node) => [
        getComputedStyle(node).fontSize,
        getComputedStyle(node).fontWeight,
      ]),
    ).toEqual(["16px", "600"]);
    await expect(
      page.getByText(
        zh
          ? "请前台改用纸单；手上的单照做；检查 Wi-Fi。"
          : "Ask the counter for paper tickets; keep cooking what you have; check the Wi-Fi.",
      ),
    ).toBeVisible();
    await expect(page.getByText(zh ? "没有进行中的工作" : "No active work")).toHaveCount(0);
    await expect(
      page.getByText(zh ? /目前没有需要制作的/u : /Nothing to make right now/u),
    ).toHaveCount(0);
    await expect(
      page.getByText(zh ? /重做信息无法刷新/u : /Remakes could not be refreshed/u),
    ).toHaveCount(0);
    await page.screenshot({ path: `test-results/b63-kds-offline-${language}.png` });
    await context.setOffline(false);
  });
