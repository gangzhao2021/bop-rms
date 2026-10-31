import { expect, test } from "@playwright/test";

const MENU_REFERENCE = "018f7600-0000-7000-8000-000000000001";

// WP-2423: the pilot menu editor fails closed without a session; nothing is invented.
test("@production CAT-MENU-BUILDER fails closed without a session at 1440/390/320", async ({
  page,
}) => {
  await page.goto(`/app/commerce/menus/${MENU_REFERENCE}`);
  await expect(page.getByRole("heading", { name: "Menus" })).toBeVisible();
  await expect(page.getByText("Menus are unavailable.")).toBeVisible();
  await expect(page.getByText("Synthetic mains")).toHaveCount(0);
  await expect(page.getByText("menuReference")).toHaveCount(0);
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
