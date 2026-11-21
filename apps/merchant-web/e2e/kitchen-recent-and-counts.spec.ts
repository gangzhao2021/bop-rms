import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { at, atTop, dishes, store, workItem } from "./kitchen-tm2-fixture";

/**
 * WP-2423 batch 44 (v15 batch 43 live check, kitchen-tabs-polish), with the data seen live.
 *
 * 1. Recently finished was measured against the board's projection time, which moves only when the
 *    kitchen's work changes. At Half Sugar Tea (16:47, last change 13:41) it read "Recently
 *    finished · 4" with 13:39/13:41 dishes and their Remake buttons; at Lane Dessert a dish 3 h
 *    14 min old. The fixture's board is projected at 18:13Z with four dishes ready 18:09-18:12Z.
 */

const minutes = (count: number) => new Date(Date.parse(at) + count * 60_000);

/** Four dishes finished between 18:09 and 18:12Z, one at a table. */
const recent = [0, 1, 2, 3].map((n) =>
  workItem(80 + n, {
    localizedDisplayNames: dishes[n],
    orderLabel:
      n === 1
        ? { orderNumber: "19", orderType: "DineIn", tableLabel: "MR41 A (TEST)" }
        : { orderNumber: String(21 + n), orderType: "Pickup", tableLabel: null },
    status: "Completed",
    completedQuantity: 1,
    orderItemReadyAt: `2026-11-20T18:${String(12 - n).padStart(2, "0")}:00.000Z`,
    ticketAggregateVersion: "5",
    workItemVersion: "3",
  }),
);

const widths = [
  [390, 844],
  [1024, 768],
  [1440, 900],
] as const;

async function chooseLanguage(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans") await page.getByRole("button", { name: "切换到中文" }).click();
  else await page.getByRole("button", { name: "Switch to English" }).click();
}

function filtersButton(page: Page) {
  return page.locator(".kitchen-filter-toggle");
}

async function chooseWorkState(page: Page, zh: boolean, value: string) {
  await filtersButton(page).click();
  const sheet = page.getByRole("dialog", { name: zh ? "筛选后厨工作" : "Filter Kitchen work" });
  await sheet.getByLabel(zh ? "工作状态" : "Work state").selectOption(value);
  await sheet.getByRole("button", { name: zh ? "完成" : "Done" }).click();
}

test("@production WP-2423 batch 44: a quiet kitchen 3 h 14 min on lists nothing as recently finished", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Lane Dessert: nothing changed in the kitchen since 18:13Z; it is now 21:27Z.
  await page.clock.setFixedTime(minutes(194));
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Named", state, { todays: [], finished: recent });
  await page.goto("/operations/kitchen");
  const recentList = page.locator(".kitchen-recent-finished:not([data-place-kept])");
  for (const language of ["en", "zh-Hans"] as const) {
    if (language === "zh-Hans") await chooseLanguage(page, language);
    const zh = language === "zh-Hans";
    for (const [width, height] of widths) {
      await atTop(page, width, height);
      await expect(recentList.locator("summary")).toHaveText(
        zh ? "最近完成 · 0" : "Recently finished · 0",
      );
      // The place kept for it says the same.
      await expect(page.locator(".kitchen-recent-finished summary").first()).toHaveText(
        zh ? "最近完成 · 0" : "Recently finished · 0",
      );
      await recentList.locator("summary").click();
      await expect(recentList.locator(".kitchen-recent-finished__none")).toHaveText(
        zh ? "最近两小时内没有完成的菜品。" : "Nothing finished in the last 2 hours.",
      );
      await expect(
        recentList.getByRole("button", { name: zh ? /^重做/u : /^Remake /u }),
      ).toHaveCount(0);
      await page.screenshot({ path: `test-results/b44-recent-quiet-${width}-${language}.png` });
      await recentList.locator("summary").click();
    }
    await expectNoInternalText(page);
  }
});

test("@production WP-2423 batch 44: Recently finished empties as the clock passes two hours, with no new work", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // 20:08Z: the oldest dish (18:09) is 1 h 59 min old.
  await page.clock.install({ time: minutes(115) });
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Named", state, { todays: [], finished: recent });
  await page.goto("/operations/kitchen");
  await page.setViewportSize({ width: 1440, height: 900 });
  const summary = page.locator(".kitchen-recent-finished:not([data-place-kept]) summary");
  await expect(summary).toHaveText("Recently finished · 4");
  // About 20:10:30Z: the dishes ready at 18:09 and 18:10 are past two hours.
  await page.clock.fastForward("02:30");
  await expect(summary).toHaveText("Recently finished · 2");
  await page.clock.fastForward("03:00");
  await expect(summary).toHaveText("Recently finished · 0");
});

test("@production WP-2423 batch 44: Remake is not offered on a card 13 hours after the dish, however quiet the board", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // 07:13Z the next morning, still the same business day (it ends 09:00Z).
  await page.clock.setFixedTime(minutes(13 * 60));
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Named", state, { todays: [], finished: recent });
  await page.goto("/operations/kitchen");
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseWorkState(page, false, "Completed");
  await expect(
    page.getByText("Beef noodles (TEST)").filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Remake", exact: true })).toHaveCount(0);
});
