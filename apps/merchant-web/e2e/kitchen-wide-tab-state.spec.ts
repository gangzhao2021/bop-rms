import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { at, atTop, store, workItem, dishes } from "./kitchen-tm2-fixture";

/**
 * WP-2423 batch 45 (v15 batch 44 live check, kitchen-recent-and-counts), with the data seen live:
 * Half Sugar Tea's order 3 (three dishes accepted, not started) and 53 tickets from earlier days.
 *
 * 1. Back office: Being made chosen in the 390 Filters sheet, then the window widened to 1024 or
 *    1440. The tabs read "Open work 3 · To make 3 · Completed 7 · All 10" with none marked, while
 *    the list said "Nothing being made". Held added a marked "Held 0" tab instead.
 * 2. Kitchen display at 1024/1440 (no Filters button there): "Find an order · Applied" showed with
 *    only Held or Being made chosen, and nothing named the state.
 */

const order3 = [
  workItem(90, {
    localizedDisplayNames: dishes[2],
    orderLabel: { orderNumber: "3", orderType: "Pickup", tableLabel: null },
  }),
  workItem(91, {
    localizedDisplayNames: dishes[3],
    orderLabel: { orderNumber: "3", orderType: "Pickup", tableLabel: null },
  }),
  workItem(92, {
    localizedDisplayNames: dishes[1],
    orderLabel: { orderNumber: "3", orderType: "Pickup", tableLabel: null },
  }),
];

const states = [
  ["In Progress", "Being made", "制作中"],
  ["Held", "Held", "暂停"],
  ["Cancelled", "Cancelled", "已取消"],
  ["Queued", "To make", "待做"],
] as const;

const wide = [
  [1024, 768],
  [1440, 900],
] as const;

async function chooseLanguage(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans") await page.getByRole("button", { name: "切换到中文" }).click();
  else await page.getByRole("button", { name: "Switch to English" }).click();
}

/** On a phone: the Filters sheet, as staff chose it live. */
async function chooseOnPhone(page: Page, zh: boolean, value: string) {
  await atTop(page, 390, 844);
  await page.locator(".kitchen-filter-toggle").click();
  const sheet = page.getByRole("dialog", { name: zh ? "筛选后厨工作" : "Filter Kitchen work" });
  await sheet.getByLabel(zh ? "工作状态" : "Work state").selectOption(value);
  await sheet.getByRole("button", { name: zh ? "完成" : "Done" }).click();
}

/** About 40 px clear of each side, so the wider Linux font (DejaVu) still fits. */
async function expectClear(page: Page, selector: string, label: string) {
  const width = page.viewportSize()?.width ?? 0;
  const element = page.locator(selector).first();
  await expect(element, label).toBeVisible();
  const box = await element.evaluate((node) => node.getBoundingClientRect().toJSON() as DOMRect);
  expect(box.left, `${label}: left edge`).toBeGreaterThanOrEqual(16);
  expect(box.right, `${label}: right edge`).toBeLessThanOrEqual(width - 40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test("@production WP-2423 batch 45: a work state chosen on the phone stays marked in the back office tabs when widened", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.clock.setFixedTime(new Date(at));
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Unverified", state, { todays: order3 });
  await page.goto("/operations/kitchen");
  for (const language of ["en", "zh-Hans"] as const) {
    if (language === "zh-Hans") await chooseLanguage(page, language);
    const zh = language === "zh-Hans";
    const tabs = page.getByRole("group", { name: zh ? "显示后厨工作" : "Show kitchen work" });
    const marked = tabs.locator('button[aria-pressed="true"]');
    for (const [value, en, cn] of states) {
      await chooseOnPhone(page, zh, value);
      for (const [width, height] of [[390, 844] as const, ...wide]) {
        const where = `${value} ${width} ${language}`;
        await atTop(page, width, height);
        await expect(marked, where).toHaveCount(1);
        await expect(marked, where).toHaveText(new RegExp(`^${zh ? cn : en}\\s*\\d+$`, "u"));
        if (width > 390)
          await expectClear(page, '.order-status-filters [aria-pressed="true"]', where);
        await page.screenshot({
          path: `test-results/b45-office-${value.replace(" ", "-")}-${width}-${language}.png`,
        });
      }
    }
    // Back to Open work: the extra tabs go; Held stays only while there is held work.
    await tabs.getByRole("button", { name: zh ? /^进行中/u : /^Open work/u }).click();
    await expect(marked).toHaveText(new RegExp(`^${zh ? "进行中" : "Open work"}\\s*3$`, "u"));
    for (const [, en, cn] of states.slice(0, 3))
      await expect(
        tabs.getByRole("button", { name: new RegExp(`^${zh ? cn : en}`, "u") }),
      ).toHaveCount(0);
    await expectNoInternalText(page);
  }
});

test("@production WP-2423 batch 45: the kitchen display names a chosen work state at 1024 and 1440 and says Applied only for a filter", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.clock.setFixedTime(new Date(at));
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Named", state, { todays: order3 });
  await page.goto("/operations/kitchen");
  const find = page.locator(".kitchen-board-heading__actions .kitchen-find-button");
  const shown = page.locator(".kitchen-queue-state");
  for (const language of ["en", "zh-Hans"] as const) {
    if (language === "zh-Hans") await chooseLanguage(page, language);
    const zh = language === "zh-Hans";
    const plain = zh ? "查找订单" : "Find an order";
    const applied = zh ? "查找订单 · 已筛选" : "Find an order · Applied";
    await atTop(page, 1440, 900);
    await expect(find).toHaveText(plain);
    await expect(shown).toHaveCount(0);
    for (const [value, en, cn] of states) {
      await chooseOnPhone(page, zh, value);
      for (const [width, height] of wide) {
        const where = `${value} ${width} ${language}`;
        await atTop(page, width, height);
        await expect(find, where).toHaveText(plain);
        await expect(shown, where).toHaveText(zh ? cn : en);
        await expectClear(page, ".kitchen-queue-state", where);
        await expectClear(page, ".kitchen-find-button", where);
        await page.screenshot({
          path: `test-results/b45-display-${value.replace(" ", "-")}-${width}-${language}.png`,
        });
      }
    }
    // A search on top of the state: Applied, and the state is still named.
    await atTop(page, 1440, 900);
    await find.click();
    const sheet = page.getByRole("dialog", { name: zh ? "筛选后厨工作" : "Filter Kitchen work" });
    await sheet.getByLabel(zh ? "单号或桌台" : "Order number or table").fill("3");
    await sheet.getByLabel(zh ? "单号或桌台" : "Order number or table").press("Enter");
    if (await sheet.isVisible())
      await sheet.getByRole("button", { name: zh ? "关闭" : "Close" }).click();
    await expect(find).toHaveText(applied);
    await expect(shown).toHaveText(zh ? "待做" : "To make");
    // Clear filters puts the board back to open work, unmarked.
    await find.click();
    await sheet.getByRole("button", { name: zh ? "清除筛选" : "Clear filters" }).click();
    await sheet.getByLabel(zh ? "单号或桌台" : "Order number or table").fill("");
    await sheet.getByLabel(zh ? "单号或桌台" : "Order number or table").press("Enter");
    if (await sheet.isVisible())
      await sheet.getByRole("button", { name: zh ? "关闭" : "Close" }).click();
    await expect(find).toHaveText(plain);
    await expect(shown).toHaveCount(0);
    await expectNoInternalText(page);
  }
});
