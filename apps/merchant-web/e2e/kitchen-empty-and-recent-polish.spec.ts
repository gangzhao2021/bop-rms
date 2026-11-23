import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { at, atTop, dishes, remake, store, workItem } from "./kitchen-tm2-fixture";

// Batch 44: Recently finished and Remake follow the device clock. Pin it to the board's time, so the
// fixture's dishes (ready 18:09-18:12Z) are as recent as the board says.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(at));
});

/**
 * WP-2423 batch 42 (v15 batch 41 live check, kitchen-phone-recent-and-counts).
 *
 * 1. With nothing to make (today's tickets done, the only remake being made), the back office's To
 *    make tab said "No matching work / Nothing matches these filters. Clear the filters…" with a
 *    Clear filters button: the tab was counted as a filter. The kitchen display did the same with
 *    its work-state choice.
 * 2. Recently finished: rows with a longer line ("MR41 A (TEST) · Order 19 · 1 ×", "· 已重做 1×")
 *    dropped Remake under the text at the left (x 49-145), the others had it at the right (x 245-341).
 * 3. "Recently finished · 0" (Half Sugar Tea, with sections) opened an empty 16 px box about 100 px
 *    under its button on a phone.
 */

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

test("@production WP-2423 batch 42: a work-state tab with nothing in it is quiet, not a filter to clear (back office)", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // As live at TM2: today's tickets all done, the only remake already being made, 53 earlier tickets.
  const state = { reworks: [remake(1, "In Progress")], commands: [] };
  await store(page, "Unverified", state, { todays: [] });
  await page.goto("/operations/kitchen");
  for (const language of ["en", "zh-Hans"] as const) {
    if (language === "zh-Hans") await chooseLanguage(page, language);
    const zh = language === "zh-Hans";
    const tabs = page.getByRole("group", { name: zh ? "显示后厨工作" : "Show kitchen work" });
    await tabs.getByRole("button", { name: zh ? /^待做/u : /^To make/u }).click();
    const empty = page.locator(".kitchen-board-empty");
    // Batch 43: the tab's own heading.
    await expect(empty).toContainText(zh ? "没有待做的工作" : "Nothing to make");
    await expect(empty).toContainText(zh ? "目前没有需要制作的。" : "Nothing to make right now.");
    await expect(empty).not.toContainText(zh ? "筛选" : "filters");
    await expect(page.getByRole("button", { name: zh ? "清除筛选" : "Clear filters" })).toHaveCount(
      0,
    );
    // No filter control calls itself applied for a tab.
    await expect(page.getByText(zh ? /已应用/u : /Applied/u)).toHaveCount(0);
    for (const [width, height] of widths) {
      await atTop(page, width, height);
      await expect(empty).toBeVisible();
      await page.screenshot({ path: `test-results/b42-office-to-make-${width}-${language}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await tabs.getByRole("button", { name: zh ? /^进行中/u : /^Open work/u }).click();
    await expect(empty).toHaveCount(0);
    await expectNoInternalText(page);
  }
});

test("@production WP-2423 batch 42: the kitchen display's work state is not a filter either; Being made says so plainly", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Named", state, { todays: [] });
  await page.goto("/operations/kitchen");
  for (const language of ["en", "zh-Hans"] as const) {
    if (language === "zh-Hans") await chooseLanguage(page, language);
    const zh = language === "zh-Hans";
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [value, text, heading] of [
      [
        "Queued",
        zh ? "目前没有需要制作的。" : "Nothing to make right now.",
        zh ? "没有待做的工作" : "Nothing to make",
      ],
      [
        "In Progress",
        zh ? "目前没有正在制作的。" : "Nothing is being made right now.",
        zh ? "没有正在制作的工作" : "Nothing being made",
      ],
    ] as const) {
      await page.getByRole("button", { name: zh ? /^筛选/u : /^Filters/u }).click();
      const sheet = page.getByRole("dialog", { name: zh ? "筛选后厨工作" : "Filter Kitchen work" });
      await sheet.getByLabel(zh ? "工作状态" : "Work state").selectOption(value);
      await sheet.getByRole("button", { name: zh ? "完成" : "Done" }).click();
      const empty = page.locator(".kitchen-board-empty");
      await expect(empty).toContainText(text);
      await expect(empty).not.toContainText(zh ? "筛选" : "filters");
      // Batch 43: the tab's own heading.
      await expect(empty).toContainText(heading);
      for (const [width, height] of widths) {
        await atTop(page, width, height);
        await expect(empty).toBeVisible();
      }
      await page.screenshot({
        path: `test-results/b42-display-${value.replace(" ", "-")}-1440-${language}.png`,
      });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    // Back to Active work for the next language.
    await page.getByRole("button", { name: zh ? /^筛选/u : /^Filters/u }).click();
    const sheet = page.getByRole("dialog", { name: zh ? "筛选后厨工作" : "Filter Kitchen work" });
    await sheet.getByLabel(zh ? "工作状态" : "Work state").selectOption("Active");
    await sheet.getByRole("button", { name: zh ? "完成" : "Done" }).click();
    await expectNoInternalText(page);
  }
});

test("@production WP-2423 batch 42: a section that hides every ticket still says the filter hides them", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  // Half Sugar Tea's shape: sections, today's tickets all in 饮品.
  const drinks = [0, 1].map((n) =>
    workItem(70 + n, {
      orderLabel: { orderNumber: String(9 + n), orderType: "Pickup", tableLabel: null },
      kitchenSection: "饮品",
    }),
  );
  await store(page, "Named", state, {
    todays: drinks,
    kitchenSections: ["饮品", "小食"],
  });
  await page.goto("/operations/kitchen");
  await page.locator(".kitchen-section-choice select").selectOption("小食");
  const empty = page.locator(".kitchen-board-empty");
  await expect(empty).toContainText("No matching work");
  await expect(empty).toContainText("Nothing matches these filters.");
});

test("@production WP-2423 batch 42 review: a drinks station keeping 饮品 chosen is quiet when the section hides nothing", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  const drink = (overrides: Record<string, unknown>) =>
    workItem(72, {
      orderLabel: { orderNumber: "11", orderType: "Pickup", tableLabel: null },
      kitchenSection: "饮品",
      ...overrides,
    });
  const filtersText = /No matching work|Nothing matches these filters|Clear the filters/u;
  // (a) The store is quiet and one drink finished today; the display is on Active work.
  await store(page, "Named", state, {
    todays: [],
    finished: [
      drink({
        status: "Completed",
        completedQuantity: 1,
        orderItemReadyAt: "2026-11-20T18:10:00.000Z",
        ticketAggregateVersion: "5",
        workItemVersion: "3",
      }),
    ],
    kitchenSections: ["饮品", "小食"],
  });
  await page.goto("/operations/kitchen");
  await page.locator(".kitchen-section-choice select").selectOption("饮品");
  const empty = page.locator(".kitchen-board-empty");
  await expect(empty).toContainText("No active work");
  await expect(empty).toContainText("Nothing to make right now.");
  await expect(empty).not.toContainText(filtersText);
  // (b) One drink is being made and To make is chosen: the tab hides it, not the section.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await store(page, "Named", state, {
    todays: [drink({ status: "In Progress" })],
    kitchenSections: ["饮品", "小食"],
  });
  await page.goto("/operations/kitchen");
  await expect(page.locator(".kitchen-section-choice select")).toHaveValue("饮品");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Filters/u }).click();
  const sheet = page.getByRole("dialog", { name: "Filter Kitchen work" });
  await sheet.getByLabel("Work state").selectOption("Queued");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(empty).toContainText("Nothing to make right now.");
  await expect(empty).not.toContainText(filtersText);
  await chooseLanguage(page, "zh-Hans");
  await page.getByRole("button", { name: /^筛选/u }).click();
  const zhSheet = page.getByRole("dialog", { name: "筛选后厨工作" });
  await zhSheet.getByLabel("工作状态").selectOption("Queued");
  await zhSheet.getByRole("button", { name: "完成" }).click();
  await expect(empty).toContainText("目前没有需要制作的。");
  await expect(empty).not.toContainText("筛选");
  await expectNoInternalText(page);
});

/** Four finished dishes as live at TM2 at 390: a table order and a dish remade once among them. */
const recent = [
  workItem(80, {
    localizedDisplayNames: dishes[0],
    orderLabel: { orderNumber: "23", orderType: "Pickup", tableLabel: null },
  }),
  workItem(81, {
    localizedDisplayNames: dishes[1],
    orderLabel: { orderNumber: "19", orderType: "DineIn", tableLabel: "MR41 A (TEST)" },
  }),
  workItem(82, {
    localizedDisplayNames: dishes[2],
    orderLabel: { orderNumber: "21", orderType: "Pickup", tableLabel: null },
  }),
  workItem(83, {
    localizedDisplayNames: dishes[3],
    orderLabel: { orderNumber: "21", orderType: "Pickup", tableLabel: null },
  }),
].map((item, n) => ({
  ...item,
  status: "Completed",
  completedQuantity: 1,
  orderItemReadyAt: `2026-11-20T18:${String(12 - n).padStart(2, "0")}:00.000Z`,
  ticketAggregateVersion: "5",
  workItemVersion: "3",
}));
/** Soy milk (Order 21) was remade once, and the remake is done. */
const soyRemade = {
  ...remake(2, "Completed"),
  originalWorkItemReference: recent[2]?.workItemReference,
  orderReference: recent[2]?.orderReference,
  orderItemReference: recent[2]?.orderItemReference,
};

for (const sections of [false, true]) {
  test(`@production WP-2423 batch 42: every Recently finished row keeps Remake in one place (${sections ? "with" : "no"} section picker)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const state = { reworks: [soyRemade] as Record<string, unknown>[], commands: [] };
    await store(page, "Named", state, {
      finished: recent,
      ...(sections ? { kitchenSections: ["饮品", "小食"] } : {}),
    });
    await page.goto("/operations/kitchen");
    for (const language of ["en", "zh-Hans"] as const) {
      if (language === "zh-Hans") await chooseLanguage(page, language);
      const zh = language === "zh-Hans";
      const recentList = page.locator(".kitchen-recent-finished:not([data-place-kept])");
      for (const [width, height] of widths) {
        await atTop(page, width, height);
        await recentList.locator("summary").click();
        await expect(recentList).toHaveAttribute("open", "");
        await expect(recentList.locator("li")).toHaveCount(4);
        await expect(recentList.locator("li").nth(1)).toContainText("MR41 A (TEST)");
        await expect(recentList.locator("li").nth(2)).toContainText(zh ? "已重做 1×" : "Remade 1×");
        const rows = await recentList.locator("li").evaluateAll((elements) =>
          elements.map((element) => {
            const row = element.getBoundingClientRect();
            const button = element.querySelector("button")?.getBoundingClientRect();
            const name = element
              .querySelector(".kitchen-recent-finished__name")
              ?.getBoundingClientRect();
            return {
              rowRight: row.right,
              rowTop: row.top,
              buttonLeft: button?.left ?? -1,
              buttonRight: button?.right ?? -1,
              buttonTop: button?.top ?? -1,
              nameRight: name?.right ?? -1,
              nameBottom: name?.bottom ?? -1,
            };
          }),
        );
        const first = rows[0];
        if (first === undefined) throw new Error("no rows");
        for (const [index, row] of rows.entries()) {
          const where = `${width} ${language} row ${index + 1}`;
          // The same place in every row: the row's end, beside (not under) the text.
          expect(Math.abs(row.buttonLeft - first.buttonLeft), `${where}: Remake left`).toBeLessThan(
            1,
          );
          expect(
            Math.abs(row.buttonRight - first.buttonRight),
            `${where}: Remake right`,
          ).toBeLessThan(1);
          expect(row.buttonLeft, `${where}: Remake beside the text`).toBeGreaterThanOrEqual(
            row.nameRight,
          );
          expect(row.buttonTop, `${where}: Remake not under the text`).toBeLessThan(row.nameBottom);
        }
        await expect(
          recentList.getByRole("button", { name: zh ? /^重做/u : /^Remake /u }).first(),
        ).toBeInViewport({
          ratio: 1,
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `test-results/b42-recent-rows-${sections ? "sections" : "plain"}-${width}-${language}.png`,
        });
        await recentList.locator("summary").click();
        await expect(recentList).not.toHaveAttribute("open", "");
      }
    }
  });

  test(`@production WP-2423 batch 42: Recently finished · 0 says so in one line, right under its button (${sections ? "with" : "no"} section picker)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const state = { reworks: [] as Record<string, unknown>[], commands: [] };
    await store(page, "Named", state, {
      finished: [],
      ...(sections ? { kitchenSections: ["饮品", "小食"] } : {}),
    });
    await page.goto("/operations/kitchen");
    for (const language of ["en", "zh-Hans"] as const) {
      if (language === "zh-Hans") await chooseLanguage(page, language);
      const zh = language === "zh-Hans";
      const recentList = page.locator(".kitchen-recent-finished:not([data-place-kept])");
      const summary = recentList.locator("summary", {
        hasText: zh ? "最近完成 · 0" : "Recently finished · 0",
      });
      for (const [width, height] of widths) {
        await atTop(page, width, height);
        await summary.click();
        await expect(recentList).toHaveAttribute("open", "");
        const panel = recentList.locator("> .kitchen-recent-finished__panel");
        await expect(panel).toHaveText(
          zh ? "最近两小时内没有完成的菜品。" : "Nothing finished in the last 2 hours.",
        );
        await expect(panel).toBeInViewport({ ratio: 1 });
        const [button, list] = await Promise.all([
          summary.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect),
          panel.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect),
        ]);
        // Anchored to its button: it opens just under it, not under the whole wrapped bar.
        expect(list.top - button.bottom, `${width} ${language}: gap under the button`).toBeLessThan(
          12,
        );
        expect(list.top - button.bottom).toBeGreaterThanOrEqual(0);
        expect(list.height, `${width} ${language}: one plain line`).toBeGreaterThan(30);
        expect(list.left).toBeGreaterThanOrEqual(8);
        expect(list.right).toBeLessThanOrEqual(width - 8);
        // A phone keeps 40 px under it, whatever the fonts.
        expect(list.bottom).toBeLessThanOrEqual(height - 40);
        await page.screenshot({
          path: `test-results/b42-recent-none-${sections ? "sections" : "plain"}-${width}-${language}.png`,
        });
        await summary.click();
        await expect(recentList).not.toHaveAttribute("open", "");
      }
      await expectNoInternalText(page);
    }
  });
}

test("@production WP-2423 batch 42: rows still open right under the button when the bar wraps on a phone", async ({
  page,
}) => {
  const state = { reworks: [soyRemade] as Record<string, unknown>[], commands: [] };
  await store(page, "Named", state, { finished: recent, kitchenSections: ["饮品", "小食"] });
  await page.goto("/operations/kitchen");
  await atTop(page, 390, 844);
  const recentList = page.locator(".kitchen-recent-finished:not([data-place-kept])");
  const summary = recentList.locator("summary");
  await summary.click();
  const panel = recentList.locator("> .kitchen-recent-finished__panel");
  const [button, list] = await Promise.all([
    summary.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect),
    panel.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect),
  ]);
  expect(list.top - button.bottom).toBeLessThan(12);
  expect(list.left).toBeGreaterThanOrEqual(8);
  expect(list.right).toBeLessThanOrEqual(390 - 8);
});
