import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { at, atTop, remake, store } from "./kitchen-tm2-fixture";

// Batch 44: Recently finished and Remake follow the device clock. Pin it to the board's time, so the
// fixture's dishes (ready 18:09-18:12Z) are as recent as the board says.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(at));
});

test("@production WP-2423 batch 40: on the back office Kitchen page a remake comes before 53 earlier-day tickets, which stay one tap away", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const state = { reworks: [remake(1, "Queued")], commands: [] as Record<string, unknown>[] };
  await store(page, "Unverified", state);
  await page.goto("/operations/kitchen");
  const lane = page.getByRole("region", { name: "Remakes" });
  const card = lane.getByRole("article", { name: /^Remake: .+, Pickup · Order 6$/u });
  await expect(card).toBeVisible();
  const attention = page.locator(".kitchen-office-earlier");
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await atTop(page, width, height);
    // The remake is on the first screen (live: y=3372 at 1440x900), today's work right under it.
    await expect(card.locator(".kitchen-work-item__summary h3")).toBeInViewport();
    if (width === 1440)
      await expect(page.locator("section.kitchen-ticket").first()).toBeInViewport();
    // The earlier days are folded into one line that says how many and what to do, never hidden.
    await expect(attention.locator("summary")).toContainText(
      "Needs attention · 53 tickets from earlier days to check and close",
    );
    const close = attention.getByRole("button", { name: "Close ticket", includeHidden: true });
    await expect(close).toHaveCount(53);
    await expect(close.first()).toBeHidden();
    const laneBox = await lane.boundingBox();
    const attentionBox = await attention.boundingBox();
    const ticketBox = await page.locator("section.kitchen-ticket").first().boundingBox();
    expect(laneBox && attentionBox && ticketBox).toBeTruthy();
    if (laneBox && attentionBox && ticketBox) {
      expect(laneBox.y).toBeLessThan(attentionBox.y);
      // Folded, the earlier days are one line between the remakes and today's tickets.
      expect(ticketBox.y - attentionBox.y).toBeLessThan(120);
    }
    await page.screenshot({ path: `test-results/b40-office-${width}.png` });
  }
  await atTop(page, 1440, 900);
  // One tap opens the list, with each dish in both names, and Close ticket offered on each.
  await attention.locator("summary").click();
  const firstRow = attention.locator("li").first();
  await expect(firstRow).toContainText("Pickup · Order 2 · From Thu, Nov 5 · not finished");
  await expect(firstRow).toContainText("1× 牛肉面 Beef noodles (TEST)");
  await expect(attention.getByRole("button", { name: "Close ticket" }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/b40-office-open-1440.png", fullPage: true });
  await expectNoInternalText(page);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);

  // The same in Chinese.
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "切换到中文" }).click(),
  ]);
  const zhAttention = page.locator(".kitchen-office-earlier");
  await expect(zhAttention.locator("summary")).toContainText("需要处理");
  await expect(zhAttention.locator("summary")).toContainText("53");
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await atTop(page, width, height);
    await expect(
      page
        .getByRole("region", { name: "重做" })
        .getByRole("article", { name: /^重做：/u })
        .locator(".kitchen-work-item__summary h3"),
    ).toBeInViewport();
    await page.screenshot({ path: `test-results/b40-office-${width}-zh.png` });
  }
});

test("@production WP-2423 batch 40: the kitchen display names a dish the same way on its card, in Recently finished and in the remake dialog", async ({
  page,
}) => {
  const state = { reworks: [remake(1, "Queued")], commands: [] as Record<string, unknown>[] };
  await store(page, "Named", state);
  await page.goto("/operations/kitchen");
  const card = page
    .getByRole("region", { name: "Remakes" })
    .getByRole("article", { name: /^Remake: 牛肉面, Pickup · Order 6$/u });
  // The card leads with the Chinese name and gives the English one under it, as every ticket does.
  await expect(card.getByRole("heading", { name: /牛肉面/u })).toBeVisible();
  await expect(card).toContainText("Beef noodles (TEST)");
  await page.getByText("Recently finished · 1").click();
  const row = page.locator(".kitchen-recent-finished li").first();
  await expect(row).toContainText("牛肉面");
  await expect(row).toContainText("Beef noodles (TEST)");
  await row.getByRole("button", { name: "Remake 牛肉面, Pickup · Order 6" }).click();
  const dialog = page.getByRole("dialog", { name: /^Remake 牛肉面/u });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Beef noodles (TEST)");
  await page.screenshot({ path: "test-results/b40-kds-names-1440.png" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("@production WP-2423 batch 40: on a 390 px phone a remake's buttons are on the first screen of the kitchen display", async ({
  page,
}) => {
  const state = { reworks: [remake(1, "Queued")], commands: [] as Record<string, unknown>[] };
  await store(page, "Named", state);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/operations/kitchen");
  const lane = page.getByRole("region", { name: "Remakes" });
  await expect(lane).toBeVisible();
  await expect(page.getByText("Pause ordering")).toBeVisible();
  for (const language of ["en", "zh"] as const) {
    if (language === "zh")
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "切换到中文" }).click(),
      ]);
    await atTop(page, 390, 844);
    const names =
      language === "en" ? ["Start remake", "Cancel remake"] : ["开始重做", /^取消重做/u];
    for (const name of names) {
      const button = page
        .getByRole("region", { name: language === "en" ? "Remakes" : "重做" })
        .getByRole("button", { name });
      await expect(button).toBeInViewport({ ratio: 1 });
      // Room to spare: a wider font (DejaVu Sans on Linux CI) takes the bar to two rows and the
      // card's badge to a second line, so the button ends at least 40 px above the fold here.
      const box = await button.boundingBox();
      expect(
        (box?.y ?? Infinity) + (box?.height ?? 0),
        `${String(name)} ends 40 px above the fold`,
      ).toBeLessThanOrEqual(844 - 40);
    }
    await page.screenshot({ path: `test-results/b40-kds-390-${language}.png` });
  }
});

test("@production WP-2423 batch 40: a remake card that has just arrived does not take a tap for a moment, and says so", async ({
  page,
}) => {
  const state = {
    reworks: [] as Record<string, unknown>[],
    commands: [] as Record<string, unknown>[],
  };
  await store(page, "Named", state);
  await page.goto("/operations/kitchen");
  await expect(page.locator("section.kitchen-ticket").first()).toBeVisible();
  // Another screen sends a remake; the cook taps it the moment it appears (DEC-KITCHEN-ONE-TAP).
  state.reworks = [remake(2, "Queued")];
  const start = page.getByRole("region", { name: "Remakes" }).getByRole("button", {
    name: "Start remake",
  });
  await start.waitFor({ state: "visible", timeout: 15_000 });
  await start.click({ delay: 0 });
  await expect(page.getByText("Moved. Tap again.")).toBeVisible();
  expect(state.commands).toEqual([]);
  // A tap after it has settled is taken.
  await page.waitForTimeout(700);
  await start.click();
  await expect
    .poll(() => state.commands.map((body) => body.action))
    .toEqual(["StartKitchenRework"]);
  await expect(page.getByText("Moved. Tap again.")).toHaveCount(0);
});
