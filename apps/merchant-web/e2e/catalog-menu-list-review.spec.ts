import { expect, test } from "@playwright/test";

test("@production CAT-MENU-LIST preserves the unavailable source boundary at 1440/390/320", async ({
  page,
}) => {
  await page.goto("/app/commerce/menus");
  await expect(page.getByRole("heading", { level: 2, name: "Menus" })).toBeVisible();
  await expect(page.getByText("Menu data unavailable")).toBeVisible();
  await expect(
    page.getByText(
      "No Menu rows or business values are shown until the scoped Catalog query is connected.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Create menu · unavailable" })).toBeDisabled();
  const filters = page.getByRole("search", { name: "Find Menus" });
  for (const label of [
    "Menu name or code",
    "Status",
    "Store",
    "Channel",
    "Locale",
    "Scheduled / error",
  ])
    await expect(filters.getByLabel(label)).toBeDisabled();
  const tableFields = [
    "Menu / code",
    "Status",
    "Scope",
    "Channels",
    "Version",
    "Effective period",
    "Sections / placements",
    "Validation",
  ];
  const mobileFields = [
    "Menu / code",
    "Status / version",
    "Scope / channels",
    "Effective period",
    "Sections / placements",
    "Validation",
  ];
  await expect(page.getByText("Synthetic All Day")).toHaveCount(0);
  await expect(page.getByText("menuReference")).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const label of width > 767 ? tableFields : mobileFields) {
      const field =
        width > 767
          ? page.locator(".catalog-menu-review__table-headings").getByText(label, { exact: true })
          : page.getByRole("status").locator("dt", { hasText: label });
      await expect(field).toBeVisible();
    }
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({ path: `test-results/catalog-menu-list-${width}.png`, fullPage: true });
  }
});
