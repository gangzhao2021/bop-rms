import { expect, test } from "@playwright/test";

// WP-2423: the pilot menu list fails closed without a session; nothing is invented.
test("@production CAT-MENU-LIST fails closed without a session at 1440/390/320", async ({
  page,
}) => {
  await page.goto("/app/commerce/menus");
  await expect(page.getByRole("heading", { name: "Menus" })).toBeVisible();
  await expect(page.getByText("Menus are unavailable.")).toBeVisible();
  // No page actions; the language switch at the end of the title row is the shell's (Owner
  // 2026-10-26).
  await expect(page.getByRole("main").locator("button:not(.language-switch)")).toHaveCount(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
});
