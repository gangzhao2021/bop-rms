import { expect, test } from "@playwright/test";

// WP-2423 / DEC-RECIPE-AUTHORING: without a merchant session the recipe screens state that recipes
// are unavailable, and stay within the viewport at every review width.
test("@production Recipe screens show their unavailable state responsively", async ({ page }) => {
  for (const path of [
    "/app/commerce/recipes",
    "/app/commerce/recipes/01909968-0000-7000-8000-000000000001/edit",
  ]) {
    await page.goto(path);
    await expect(page.getByText("Recipes are unavailable.", { exact: true })).toBeVisible();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  }
});
