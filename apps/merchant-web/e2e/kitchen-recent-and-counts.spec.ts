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
 * 2. In the back office, Held or Being made left the button "Filters · Active work"; the kitchen
 *    display said "Filters · Applied" for the same choice.
 * 3. Being made or Held with three dishes waiting in To make read "0 work items" (back office
 *    "Today 0 work items"), as if the kitchen were idle.
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

/** Tea order 3: one drink and two snacks, accepted, not started. */
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

const widths = [
  [390, 844],
  [1024, 768],
  [1440, 900],
] as const;

async function chooseLanguage(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "切换到中文" }).click(),
    ]);
  else
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Switch to English" }).click(),
    ]);
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

/** On screen with room to spare on each side, so a wider Linux font does not tip it over. */
async function expectWithin(page: Page, selector: string, label: string) {
  const width = page.viewportSize()?.width ?? 0;
  const box = await page
    .locator(selector)
    .first()
    .evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
  expect(box.left, `${label}: left edge`).toBeGreaterThanOrEqual(8);
  expect(box.right, `${label}: right edge`).toBeLessThanOrEqual(width - 8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
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

for (const surface of ["display", "back office"] as const)
  test(`@production WP-2423 batch 44: the Filters button names the chosen work state (${surface})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.clock.setFixedTime(new Date(at));
    const state = { reworks: [] as Record<string, unknown>[], commands: [] };
    await store(page, surface === "display" ? "Named" : "Unverified", state, { todays: order3 });
    await page.goto("/operations/kitchen");
    for (const language of ["en", "zh-Hans"] as const) {
      if (language === "zh-Hans") await chooseLanguage(page, language);
      const zh = language === "zh-Hans";
      await page.setViewportSize({ width: 390, height: 844 });
      const button = filtersButton(page);
      await expect(button).toHaveText(zh ? "筛选 · 进行中的工作" : "Filters · Active work");
      for (const [value, en, cn] of [
        ["Held", "Held", "暂停"],
        ["In Progress", "Being made", "制作中"],
        ["Queued", "To make", "待做"],
        ["Completed", "Completed", "已完成"],
      ] as const) {
        await chooseWorkState(page, zh, value);
        await expect(button, `${value} ${language}`).toHaveText(
          zh ? `筛选 · ${cn}` : `Filters · ${en}`,
        );
        await expectWithin(page, ".kitchen-filter-toggle", `${value} ${language}`);
        await page.screenshot({
          path: `test-results/b44-filters-${surface.replace(" ", "-")}-${value.replace(" ", "-")}-${language}.png`,
        });
      }
      // With an order searched for as well, the button says filters are applied.
      await button.click();
      const sheet = page.getByRole("dialog", { name: zh ? "筛选后厨工作" : "Filter Kitchen work" });
      await sheet.getByLabel(zh ? "单号或桌台" : "Order number or table").fill("3");
      await sheet.getByLabel(zh ? "单号或桌台" : "Order number or table").press("Enter");
      await expect(button).toHaveText(zh ? "筛选 · 已应用" : "Filters · Applied");
      await chooseWorkState(page, zh, "Active");
      await button.click();
      await sheet.getByLabel(zh ? "单号或桌台" : "Order number or table").fill("");
      await sheet.getByLabel(zh ? "单号或桌台" : "Order number or table").press("Enter");
      await expect(button).toHaveText(zh ? "筛选 · 进行中的工作" : "Filters · Active work");
      await expectNoInternalText(page);
    }
  });

for (const surface of ["display", "back office"] as const)
  test(`@production WP-2423 batch 44: Being made or Held says what waits in To make (${surface})`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.clock.setFixedTime(new Date(at));
    const state = { reworks: [] as Record<string, unknown>[], commands: [] };
    await store(page, surface === "display" ? "Named" : "Unverified", state, { todays: order3 });
    await page.goto("/operations/kitchen");
    const count = page.locator(".kitchen-queue-count");
    for (const language of ["en", "zh-Hans"] as const) {
      if (language === "zh-Hans") await chooseLanguage(page, language);
      const zh = language === "zh-Hans";
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(count).toHaveText(zh ? "3 项工作" : "3 work items");
      for (const value of ["In Progress", "Held"] as const) {
        await page.setViewportSize({ width: 390, height: 844 });
        await chooseWorkState(page, zh, value);
        for (const [width, height] of widths) {
          const where = `${value} ${width} ${language}`;
          await atTop(page, width, height);
          await expect(count, where).toHaveText(
            zh ? "0 项工作 · 待做 3 项" : "0 work items · 3 waiting in To make",
          );
          if (surface === "back office")
            await expect(page.locator(".workspace-page__meta")).toContainText(
              zh ? "今天 0 项工作 · 待做 3 项" : "Today 0 work items · 3 waiting in To make",
            );
          await expect(count).toBeInViewport({ ratio: 1 });
          await expectWithin(page, ".kitchen-queue-count", where);
          await page.screenshot({
            path: `test-results/b44-count-${surface.replace(" ", "-")}-${value.replace(" ", "-")}-${width}-${language}.png`,
          });
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await chooseWorkState(page, zh, "Active");
      await expect(count).toHaveText(zh ? "3 项工作" : "3 work items");
      await expectNoInternalText(page);
    }
  });

test("@production WP-2423 batch 44: To make with dishes on the stove says they are being made (back office)", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.clock.setFixedTime(new Date(at));
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Unverified", state, {
    todays: order3.map((item) => ({ ...item, status: "In Progress" })),
  });
  await page.goto("/operations/kitchen");
  for (const language of ["en", "zh-Hans"] as const) {
    if (language === "zh-Hans") await chooseLanguage(page, language);
    const zh = language === "zh-Hans";
    await page.setViewportSize({ width: 1440, height: 900 });
    const tabs = page.getByRole("group", { name: zh ? "显示后厨工作" : "Show kitchen work" });
    await tabs.getByRole("button", { name: zh ? /^待做/u : /^To make/u }).click();
    for (const [width, height] of widths) {
      await atTop(page, width, height);
      await expect(page.locator(".workspace-page__meta")).toContainText(
        zh ? "今天 0 项工作 · 制作中 3 项" : "Today 0 work items · 3 being made",
      );
      await expectWithin(page, ".kitchen-queue-count", `${width} ${language}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await tabs.getByRole("button", { name: zh ? /^未完成/u : /^Open work/u }).click();
    await expect(page.locator(".kitchen-queue-count")).toHaveText(zh ? "3 项工作" : "3 work items");
  }
});

// Batch 58 (v15 b57: Orders said 较早营业日, the kitchen back office header "另有 53 张是之前的"):
// one name for earlier days, with Test Merchant 2's 53 earlier-day tickets.
test("@production b58: the back office kitchen header names earlier days as Orders does", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.clock.setFixedTime(new Date(at));
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Unverified", state);
  await page.goto("/operations/kitchen");
  const meta = page.locator(".kitchen-board-heading .workspace-page__meta");
  for (const language of ["en", "zh-Hans"] as const) {
    if (language === "zh-Hans") await chooseLanguage(page, language);
    const zh = language === "zh-Hans";
    for (const [width, height] of widths) {
      await atTop(page, width, height);
      await expect(meta).toContainText(
        zh ? "· 另有 53 张来自较早营业日" : "· 53 more from earlier days",
      );
      await expect(page.locator("body")).not.toContainText("是之前的");
      await expect(page.locator("body")).not.toContainText("之前营业日");
      // Room to spare for wider Linux fonts (DejaVu): the line ends 40 px inside the page.
      const right = await meta.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return Math.max(...[...range.getClientRects()].map((rect) => rect.right));
      });
      expect(right, `${width} ${language}`).toBeLessThanOrEqual(width - 40);
      await expectWithin(
        page,
        ".kitchen-board-heading .workspace-page__meta",
        `${width} ${language}`,
      );
      await page.screenshot({ path: `test-results/b58-kitchen-earlier-${language}-${width}.png` });
    }
  }
});
