import { expect, test } from "@playwright/test";

test("@production INV-ITEM-LIST keeps the Phase 2 source boundary at desktop and mobile widths", async ({
  page,
}) => {
  await page.goto("/app/supply/items");
  await expect(page.getByRole("heading", { name: "OPERATIONS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inventory items" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "PHASE 2 · ITEM PROJECTION UNAVAILABLE" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Inventory Item source unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Create item · unavailable" })).toBeDisabled();
  const filters = page.getByRole("group", { name: "Find and filter items" });
  await expect(filters.getByRole("textbox", { name: "Search inventory items" })).toBeDisabled();
  for (const label of [
    "Lifecycle / type filter",
    "Tracking / lot-expiry filter",
    "Store scope / quantity filter",
  ])
    await expect(filters.getByLabel(label)).toBeDisabled();
  await expect(page.getByText("Authorized Item source unavailable")).toBeVisible();
  for (const text of ["Synthetic ingredient", "12.5000", "Authorized Store scope"])
    await expect(page.getByText(text)).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({
      path: `test-results/inventory-item-list-${width}.png`,
      fullPage: true,
    });
  }
});
