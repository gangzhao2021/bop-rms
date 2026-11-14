import { expect, test } from "@playwright/test";
// WP-2423 pilot: this route is now the Store's working page (stock counts / supply items under
// WP-2423 inventory operations); the "Phase 2 source boundary" placeholders this spec asserts no
// longer exist. Kept for the record; coverage of the working pages lives in their unit tests.
test.skip(true, "WP-2423 pilot: the placeholder page this spec asserts was replaced");

test("@production INV-ITEM-DETAIL keeps source values and actions unavailable at 1440/390/320", async ({
  page,
}) => {
  await page.goto("/app/supply/items/018fa700-0000-7000-8000-000000000010");
  await expect(page.getByRole("heading", { name: "OPERATIONS" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Inventory Item detail", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Inventory Item detail source unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "AUTHORIZED ITEM DETAIL QUERY UNAVAILABLE" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Inventory Item detail sections" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  for (const button of ["Edit unavailable", "Duplicate unavailable", "Manage policy unavailable"])
    await expect(page.getByRole("button", { name: button })).toBeDisabled();
  for (const section of [
    "Descriptive fields unavailable",
    "Units & conversions unavailable",
    "Tracking & lot / expiry unavailable",
    "Stock by location · scope required unavailable",
    "Reorder policies unavailable",
    "Supplier mappings unavailable",
    "Recipe / SKU usage unavailable",
    "Movements, counts & history unavailable",
  ])
    await expect(page.getByRole("region", { name: section })).toBeVisible();
  for (const text of ["Synthetic ingredient", "12.5000", "Authorized Store scope", "ITEM_01"])
    await expect(page.getByText(text)).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({
      path: `test-results/inventory-item-detail-${width}.png`,
      fullPage: true,
    });
  }
});
