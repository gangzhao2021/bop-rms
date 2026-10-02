import { expect, test } from "@playwright/test";

const MENU_REFERENCE = "018f7600-0000-7000-8000-000000000001";

test("@production CAT-MENU-BUILDER keeps its unavailable source boundary at 1440/390/320", async ({
  page,
}) => {
  await page.goto(`/app/commerce/menus/${MENU_REFERENCE}/edit`);
  await expect(page.getByRole("heading", { level: 2, name: "Menu builder" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Menu sections unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Validation unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft actions stay unavailable" })).toBeVisible();
  await expect(
    page.getByText(
      "Menu, placement, localized override, availability reference and validation values are unavailable until the authorized Catalog projection is connected.",
    ),
  ).toBeVisible();
  for (const label of [
    "Save draft · unavailable",
    "Validate · unavailable",
    "Add section · unavailable",
    "Submit review · unavailable",
    "Approve · unavailable",
    "Publish / schedule · unavailable",
    "Archive · unavailable",
  ])
    await expect(page.getByRole("button", { name: label })).toBeDisabled();
  await expect(page.getByText("Synthetic mains")).toHaveCount(0);
  await expect(page.getByText("menuReference")).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of [
      "Menu identity & scope",
      "Menu structure",
      "Validation rail",
      "Publish workflow",
    ])
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({
      path: `test-results/catalog-menu-builder-${width}.png`,
      fullPage: true,
    });
  }
});
