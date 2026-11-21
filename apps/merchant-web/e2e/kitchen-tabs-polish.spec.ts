import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { atTop, dishes, remake, store, workItem } from "./kitchen-tm2-fixture";

/**
 * WP-2423 batch 43 (v15 batch 42 live check, kitchen-empty-and-recent-polish), with the data seen
 * live at Half Sugar Tea (owner-tea): sections 饮品 and 小食, six earlier-day tickets (the fixture's
 * 53 TM2 ones stand in), and a three-dish order still to make.
 *
 * 1. At 1024 and 1440 the Recently finished panel (list or zero line) kept to the right edge of the
 *    heading bar: at 1440 en the button spanned x 684-846 and the panel x 996-1416, under "Kitchen
 *    section / Find an order".
 * 2. Being made / Held, with work waiting to be made, said "No active work" (没有进行中的工作).
 * 3. Switching the language reset the chosen work-state tab to Open work (back office and kitchen
 *    display).
 */

const sections = ["饮品", "小食"];
/** Order 1 at tea: one drink and two snacks, accepted, not started. */
const order1 = [
  workItem(90, {
    localizedDisplayNames: dishes[2],
    orderLabel: { orderNumber: "1", orderType: "Pickup", tableLabel: null },
    kitchenSection: "饮品",
  }),
  workItem(91, {
    localizedDisplayNames: dishes[3],
    orderLabel: { orderNumber: "1", orderType: "Pickup", tableLabel: null },
    kitchenSection: "小食",
  }),
  workItem(92, {
    localizedDisplayNames: dishes[1],
    orderLabel: { orderNumber: "1", orderType: "Pickup", tableLabel: null },
    kitchenSection: "小食",
  }),
];

async function chooseLanguage(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans") await page.getByRole("button", { name: "切换到中文" }).click();
  else await page.getByRole("button", { name: "Switch to English" }).click();
}

async function chooseWorkState(page: Page, zh: boolean, value: string) {
  await page.getByRole("button", { name: zh ? /^筛选/u : /^Filters/u }).click();
  const sheet = page.getByRole("dialog", { name: zh ? "筛选后厨工作" : "Filter Kitchen work" });
  await sheet.getByLabel(zh ? "工作状态" : "Work state").selectOption(value);
  await sheet.getByRole("button", { name: zh ? "完成" : "Done" }).click();
}

async function workStateChosen(page: Page, zh: boolean): Promise<string> {
  await page.getByRole("button", { name: zh ? /^筛选/u : /^Filters/u }).click();
  const sheet = page.getByRole("dialog", { name: zh ? "筛选后厨工作" : "Filter Kitchen work" });
  const value = await sheet.getByLabel(zh ? "工作状态" : "Work state").inputValue();
  await sheet.getByRole("button", { name: zh ? "完成" : "Done" }).click();
  return value;
}

/** Four dishes finished in the last two hours (TM2's shape, a table order among them). */
const recent = [0, 1, 2, 3].map((n) =>
  workItem(80 + n, {
    localizedDisplayNames: dishes[n],
    orderLabel:
      n === 1
        ? { orderNumber: "19", orderType: "DineIn", tableLabel: "MR41 A (TEST)" }
        : { orderNumber: String(21 + n), orderType: "Pickup", tableLabel: null },
    kitchenSection: n === 2 ? "饮品" : "小食",
    status: "Completed",
    completedQuantity: 1,
    orderItemReadyAt: `2026-11-20T18:${String(12 - n).padStart(2, "0")}:00.000Z`,
    ticketAggregateVersion: "5",
    workItemVersion: "3",
  }),
);

for (const withSections of [false, true])
  for (const rows of [0, 4])
    test(`@production WP-2423 batch 43: Recently finished · ${rows} opens under its own button at every width (${withSections ? "with" : "no"} section picker)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const state = { reworks: [] as Record<string, unknown>[], commands: [] };
      await store(page, "Named", state, {
        todays: [],
        finished: rows === 0 ? [] : recent,
        ...(withSections ? { kitchenSections: sections } : {}),
      });
      await page.goto("/operations/kitchen");
      for (const language of ["en", "zh-Hans"] as const) {
        if (language === "zh-Hans") await chooseLanguage(page, language);
        const recentList = page.locator(".kitchen-recent-finished:not([data-place-kept])");
        const summary = recentList.locator("summary");
        const panel = recentList.locator("> .kitchen-recent-finished__panel");
        for (const [width, height] of [
          [390, 844],
          [1024, 768],
          [1440, 900],
        ] as const) {
          const where = `${width} ${language}`;
          await atTop(page, width, height);
          await summary.click();
          await expect(recentList).toHaveAttribute("open", "");
          await expect(panel).toBeInViewport({ ratio: 1 });
          const [button, list] = await Promise.all([
            summary.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect),
            panel.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect),
          ]);
          expect(list.top - button.bottom, `${where}: just under its button`).toBeLessThan(12);
          expect(list.top - button.bottom).toBeGreaterThanOrEqual(0);
          // Fully inside the screen, with room to spare whatever the fonts.
          expect(list.left, `${where}: left margin`).toBeGreaterThanOrEqual(8);
          expect(list.right, `${where}: right margin`).toBeLessThanOrEqual(width - 8);
          if (width >= 768) {
            // Anchored to its own button: the panel spans it, and starts or ends with it.
            expect(list.left, `${where}: panel starts at or before the button`).toBeLessThanOrEqual(
              button.left + 1,
            );
            expect(list.right, `${where}: panel reaches past the button`).toBeGreaterThanOrEqual(
              button.right - 1,
            );
            expect(
              Math.min(Math.abs(list.left - button.left), Math.abs(list.right - button.right)),
              `${where}: lined up with one edge of the button`,
            ).toBeLessThan(1);
          } else {
            // A phone keeps the batch 42 shape: the bar's whole width, under the button.
            expect(list.width, `${where}: the bar's width`).toBeGreaterThan(width - 60);
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          await page.screenshot({
            path: `test-results/b43-recent-${rows}-${withSections ? "sections" : "plain"}-${width}-${language}.png`,
          });
          await summary.click();
          await expect(recentList).not.toHaveAttribute("open", "");
        }
        await expectNoInternalText(page);
      }
    });

test("@production WP-2423 batch 43: Being made and Held with work to make have their own heading (kitchen display)", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Named", state, { todays: order1, kitchenSections: sections });
  await page.goto("/operations/kitchen");
  const empty = page.locator(".kitchen-board-empty");
  for (const language of ["en", "zh-Hans"] as const) {
    if (language === "zh-Hans") await chooseLanguage(page, language);
    const zh = language === "zh-Hans";
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [value, heading, line] of [
      [
        "In Progress",
        zh ? "没有正在制作的工作" : "Nothing being made",
        zh ? "目前没有正在制作的。" : "Nothing is being made right now.",
      ],
      [
        "Held",
        zh ? "没有暂停的工作" : "Nothing held",
        zh ? "目前没有暂停的工作。" : "Nothing is held right now.",
      ],
    ] as const) {
      await chooseWorkState(page, zh, value);
      await expect(empty.getByRole("heading")).toHaveText(heading);
      await expect(empty).toContainText(line);
      // Work is waiting to be made: the board never says there is no active work.
      await expect(empty).not.toContainText(zh ? "没有进行中的工作" : "No active work");
      await expect(empty).not.toContainText(zh ? "筛选" : "filters");
      for (const [width, height] of [
        [390, 844],
        [1024, 768],
        [1440, 900],
      ] as const) {
        await atTop(page, width, height);
        await expect(empty).toBeInViewport();
        await page.screenshot({
          path: `test-results/b43-display-${value.replace(" ", "-")}-${width}-${language}.png`,
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await chooseWorkState(page, zh, "Active");
    await expect(empty).toHaveCount(0);
    await expectNoInternalText(page);
  }
});

test("@production WP-2423 batch 43: To make with only work being made says Nothing to make (back office)", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Unverified", state, {
    todays: order1.map((item) => ({ ...item, status: "In Progress" })),
    kitchenSections: sections,
  });
  await page.goto("/operations/kitchen");
  const empty = page.locator(".kitchen-board-empty");
  for (const language of ["en", "zh-Hans"] as const) {
    if (language === "zh-Hans") await chooseLanguage(page, language);
    const zh = language === "zh-Hans";
    await page.setViewportSize({ width: 1440, height: 900 });
    const tabs = page.getByRole("group", { name: zh ? "显示后厨工作" : "Show kitchen work" });
    await tabs.getByRole("button", { name: zh ? /^待做/u : /^To make/u }).click();
    await expect(empty.getByRole("heading")).toHaveText(zh ? "没有待做的工作" : "Nothing to make");
    await expect(empty).toContainText(zh ? "目前没有需要制作的。" : "Nothing to make right now.");
    await expect(empty).not.toContainText(zh ? "没有进行中的工作" : "No active work");
    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1440, 900],
    ] as const) {
      await atTop(page, width, height);
      await expect(empty).toBeVisible();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await tabs.getByRole("button", { name: zh ? /^进行中/u : /^Open work/u }).click();
    await expectNoInternalText(page);
  }
});

test("@production WP-2423 batch 43: switching language keeps the back office's tab and section", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Unverified", state, { todays: order1, kitchenSections: sections });
  await page.goto("/operations/kitchen");
  // As live: 饮品 and To make chosen at 1440, then 中文.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("combobox", { name: "Kitchen section" }).selectOption("饮品");
  const tabs = page.getByRole("group", { name: "Show kitchen work" });
  const zhTabs = page.getByRole("group", { name: "显示后厨工作" });
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await tabs.getByRole("button", { name: /^To make/u }).click();
    await chooseLanguage(page, "zh-Hans");
    await expect(
      zhTabs.getByRole("button", { name: /^待做/u }),
      `${width}: 待做 kept`,
    ).toHaveAttribute("aria-pressed", "true");
    await expect(zhTabs.getByRole("button", { name: /^进行中/u })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await page.screenshot({ path: `test-results/b43-office-kept-${width}-zh.png` });
    await zhTabs.getByRole("button", { name: /^已完成/u }).click();
    await chooseLanguage(page, "en");
    await expect(
      tabs.getByRole("button", { name: /^Completed/u }),
      `${width}: Completed kept`,
    ).toHaveAttribute("aria-pressed", "true");
    // The section stays chosen too.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("combobox", { name: "Kitchen section" })).toHaveValue("饮品");
    await tabs.getByRole("button", { name: /^Open work/u }).click();
  }
  await expectNoInternalText(page);
});

for (const withSections of [false, true])
  test(`@production WP-2423 batch 43: switching language keeps the kitchen display's work state (${withSections ? "with" : "no"} section picker)`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const state = { reworks: [remake(1, "Queued")], commands: [] };
    await store(page, "Named", state, {
      todays: order1,
      ...(withSections ? { kitchenSections: sections } : {}),
    });
    await page.goto("/operations/kitchen");
    await page.setViewportSize({ width: 390, height: 844 });
    if (withSections) await page.locator(".kitchen-section-choice select").selectOption("小食");
    await chooseWorkState(page, false, "In Progress");
    await chooseLanguage(page, "zh-Hans");
    expect(await workStateChosen(page, true), "制作中 kept").toBe("In Progress");
    if (withSections)
      await expect(page.locator(".kitchen-section-choice select")).toHaveValue("小食");
    await expect(page.locator(".kitchen-board-empty")).toContainText("目前没有正在制作的。");
    await page.screenshot({
      path: `test-results/b43-display-kept-${withSections ? "sections" : "plain"}-390-zh.png`,
    });
    await chooseWorkState(page, true, "Queued");
    await chooseLanguage(page, "en");
    expect(await workStateChosen(page, false), "To make kept").toBe("Queued");
    for (const [width, height] of [
      [1024, 768],
      [1440, 900],
    ] as const) {
      await atTop(page, width, height);
      await expect(page.locator(".kitchen-board-empty")).toHaveCount(0);
    }
    await expectNoInternalText(page);
  });
