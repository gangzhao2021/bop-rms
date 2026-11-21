import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { atTop, dishes, remake, store, workItem } from "./kitchen-tm2-fixture";

/**
 * WP-2423 batch 41 (v15 batch 40 live check, Test Merchant 2, kitchen-office-remakes).
 *
 * 1. On a 390 px kitchen display Recently finished sits at the left of the bar, but its list was
 *    anchored to its right edge and 342 px wide, so it opened at x = -167 (en) / -234 (zh-Hans):
 *    the dish, the order and the Remake button were off screen.
 * 2. While the only open work was a remake, the screen said "Today 0 work items", "Open work 0 /
 *    To make 0" and "Nothing to make right now." under the Remakes 1 card.
 * 3. The back office said "Needs attention · 53 tickets …", the display "53 tickets …", and the
 *    empty state pointed at "From earlier days above", a heading neither shows.
 */

/** Four dishes finished in the last half hour, newest first, as the verifier had at 390 in zh. */
const recent = [0, 1, 2, 3].map((n) =>
  workItem(64 + n, {
    localizedDisplayNames: dishes[n],
    orderLabel: { orderNumber: String(6 - n), orderType: "Pickup", tableLabel: null },
    status: "Completed",
    completedQuantity: 1,
    orderItemReadyAt: `2026-11-20T18:${String(12 - n).padStart(2, "0")}:00.000Z`,
    ticketAggregateVersion: "5",
    workItemVersion: "3",
  }),
);

/** Fully on screen, with 8 px to spare on each side (a wider Linux font must not tip it over). */
async function expectInView(page: Page, selector: string, label: string) {
  const width = page.viewportSize()?.width ?? 0;
  const boxes = await page
    .locator(selector)
    .evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().toJSON() as DOMRect),
    );
  expect(boxes.length, `${label}: shown`).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.left, `${label}: left edge on screen`).toBeGreaterThanOrEqual(8);
    expect(box.right, `${label}: right edge on screen`).toBeLessThanOrEqual(width - 8);
  }
}

for (const surface of ["display", "display with sections", "back office"] as const) {
  test(`@production WP-2423 batch 41: Recently finished opens fully on screen at every width (${surface})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const state = { reworks: [] as Record<string, unknown>[], commands: [] };
    await store(page, surface === "back office" ? "Unverified" : "Named", state, {
      finished: recent,
      ...(surface === "display with sections" ? { kitchenSections: ["炒锅", "蒸柜"] } : {}),
    });
    await page.goto("/operations/kitchen");
    for (const language of ["en", "zh-Hans"] as const) {
      if (language === "zh-Hans") await page.getByRole("button", { name: "切换到中文" }).click();
      const summaryText = language === "en" ? "Recently finished · 4" : "最近完成 · 4";
      const remakeName = language === "en" ? /^Remake /u : /^重做/u;
      if (surface === "display with sections")
        await expect(page.locator(".kitchen-section-choice select")).toBeVisible();
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1024, 768],
        [1440, 900],
      ] as const) {
        await atTop(page, width, height);
        const recentList = page.locator(".kitchen-recent-finished:not([data-place-kept])");
        await recentList.locator("summary", { hasText: summaryText }).click();
        await expect(recentList).toHaveAttribute("open", "");
        await expectInView(page, ".kitchen-recent-finished[open] > ul", "panel");
        await expectInView(page, ".kitchen-recent-finished[open] li", "row");
        const buttons = recentList.getByRole("button", { name: remakeName });
        await expect(buttons).toHaveCount(4);
        // The newest dish, its order and its Remake are on screen as the list opens.
        await expect(recentList.locator("li").first()).toContainText("牛肉面");
        await expect(recentList.locator("li").first().locator("strong")).toBeInViewport({
          ratio: 1,
        });
        await expect(buttons.first()).toBeInViewport({ ratio: 1 });
        // Each Remake is fully readable once the list (at most 60% of the screen tall) shows it;
        // a wider Linux font may make the list scroll, never the page sideways.
        for (const button of await buttons.all()) {
          await button.scrollIntoViewIfNeeded();
          await expect(button).toBeInViewport({ ratio: 1 });
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `test-results/b41-recent-${surface.replaceAll(" ", "-")}-${width}-${language}.png`,
        });
        await recentList.locator("summary").click();
        await expect(recentList).not.toHaveAttribute("open", "");
      }
    }
  });
}

test("@production WP-2423 batch 41: tapping Remake folds Recently finished, so the new card is not covered", async ({
  page,
}) => {
  const state = { reworks: [] as Record<string, unknown>[], commands: [] };
  await store(page, "Named", state, { finished: recent });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/operations/kitchen");
  const recentList = page.locator(".kitchen-recent-finished:not([data-place-kept])");
  await recentList.locator("summary").click();
  await recentList.getByRole("button", { name: "Remake 牛肉面, Pickup · Order 6" }).click();
  await expect(page.getByRole("dialog", { name: /^Remake 牛肉面/u })).toBeVisible();
  await expect(recentList).not.toHaveAttribute("open", "");
});

test("@production WP-2423 batch 41: a waiting remake is counted as work, and the board never says there is nothing to make", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // As live: no other ticket open today, Order 6 finished, its remake to make; 53 earlier tickets.
  for (const surface of ["back office", "display"] as const) {
    const state = { reworks: [remake(1, "Queued")], commands: [] };
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await store(page, surface === "back office" ? "Unverified" : "Named", state, {
      todays: [],
    });
    await page.goto("/operations/kitchen");
    for (const language of ["en", "zh-Hans"] as const) {
      if (language === "zh-Hans") await page.getByRole("button", { name: "切换到中文" }).click();
      const zh = language === "zh-Hans";
      await expect(
        page.getByRole("region", { name: zh ? "重做" : "Remakes" }).getByRole("article"),
      ).toHaveCount(1);
      await expect(page.locator(".kitchen-queue-count").first()).toHaveText(
        zh ? "1 项工作" : "1 work item",
      );
      if (surface === "back office") {
        await expect(page.locator(".workspace-page__meta")).toContainText(
          zh ? "今天 1 项工作" : "Today 1 work item",
        );
        const tabs = page.getByRole("group", { name: zh ? "显示后厨工作" : "Show kitchen work" });
        await expect(
          tabs.getByRole("button", { name: zh ? /^进行中/u : /^Open work/u }),
        ).toHaveText(zh ? /1$/u : "Open work1");
        await expect(tabs.getByRole("button", { name: zh ? /^待做/u : /^To make/u })).toHaveText(
          zh ? /1$/u : "To make1",
        );
        // The To make tab counts the remake, so it does not call itself empty either.
        await tabs.getByRole("button", { name: zh ? /^待做/u : /^To make/u }).click();
        await expect(page.locator(".kitchen-board-empty")).toHaveCount(0);
        await tabs.getByRole("button", { name: zh ? /^进行中/u : /^Open work/u }).click();
      }
      await expect(page.locator(".kitchen-board-empty")).toHaveCount(0);
      await expect(
        page.getByText(zh ? "目前没有需要制作的。" : "Nothing to make right now."),
      ).toHaveCount(0);
      await expect(page.getByText(zh ? "没有进行中的工作" : "No active work")).toHaveCount(0);
      for (const [width, height] of [
        [1440, 900],
        [1024, 768],
        [390, 844],
      ] as const) {
        await atTop(page, width, height);
        await page.screenshot({
          path: `test-results/b41-counts-${surface.replaceAll(" ", "-")}-${width}-${language}.png`,
        });
      }
      await expectNoInternalText(page);
    }
    await page.getByRole("button", { name: "Switch to English" }).click();
  }
});
