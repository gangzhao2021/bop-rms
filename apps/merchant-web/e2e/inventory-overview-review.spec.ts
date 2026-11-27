import { expect, test } from "@playwright/test";
// v15 aa3d9fac D3 (pilot rule "no reachable stubs"): the production workspace now sends this
// address to a working screen until the screen has real sources (checked for every route by
// pilot-routes.spec.ts); the layout it asserts stays in the local demo. Kept for the record.
test.skip(true, "v15 aa3d9fac D3: this screen is hidden in the production workspace");

test("@production INV-STOCK-OVERVIEW keeps the Figma source boundary at desktop and mobile widths", async ({
  page,
}) => {
  await page.goto("/operations/inventory");
  await expect(page.getByRole("heading", { name: "OPERATIONS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stock overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stock projection unavailable" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Stock source unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh unavailable" })).toBeDisabled();
  const filters = page.getByRole("group", { name: "Find and filter items" });
  await expect(filters).toBeVisible();
  await expect(filters.getByRole("textbox", { name: "Search inventory items" })).toBeDisabled();
  for (const label of [
    "Category filter",
    "Location filter",
    "Availability filter",
    "Below reorder filter",
    "Expiry filter",
    "Negative stock filter",
    "Tracking filter",
  ])
    await expect(filters.getByLabel(label)).toBeDisabled();
  await expect(page.getByText("Stock items unavailable")).toBeVisible();
  await expect(page.getByText("Synthetic ingredient")).toHaveCount(0);
  await expect(page.getByText("12.5000")).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({ path: `test-results/inventory-overview-${width}.png`, fullPage: true });
  }
});
