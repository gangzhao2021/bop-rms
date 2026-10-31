import { expect, test } from "@playwright/test";
// WP-2423 pilot: this route is now the Store's working page (stock counts / supply items under
// WP-2423 inventory operations); the "Phase 2 source boundary" placeholders this spec asserts no
// longer exist. Kept for the record; coverage of the working pages lives in their unit tests.
test.skip(true, "WP-2423 pilot: the placeholder page this spec asserts was replaced");

test("@production Inventory Item Create/Edit remain source-bound at 1440/390/320", async ({
  page,
}) => {
  const routes = [
    {
      mode: "create",
      url: "/app/supply/items/new",
      title: "Create inventory item",
    },
    {
      mode: "edit",
      url: "/app/supply/items/018fa700-0000-7000-8000-000000000010/edit",
      title: "Edit inventory item",
    },
  ] as const;
  for (const route of routes) {
    await page.goto(route.url);
    await expect(page.getByRole("heading", { name: "OPERATIONS" })).toBeVisible();
    await expect(page.getByRole("heading", { name: route.title, level: 2 })).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Authorized Item source unavailable" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Inventory Item form sections" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Identity and handling" })).toBeVisible();
    for (const field of [
      "Internal code",
      "Localized name",
      "Item type / category",
      "Base unit",
      "Tracking mode",
      "Lot / expiry policy",
      "Negative stock policy",
      "Reorder policy · Store scoped",
    ])
      await expect(page.getByText(field, { exact: true })).toBeVisible();
    await expect(
      page.getByText("Quantity and opening balance are never Item fields."),
    ).toBeVisible();
    for (const button of await page.getByRole("button").all()) await expect(button).toBeDisabled();
    await expect(page.locator("input, select, textarea")).toHaveCount(0);
    for (const text of ["Synthetic ingredient", "12.5000", "Authorized Store scope", "ITEM_01"])
      await expect(page.getByText(text)).toHaveCount(0);

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const overflow = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
      }));
      expect(overflow.document, `${route.mode} ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(
        overflow.viewport,
      );
      await page.screenshot({
        path: `test-results/inventory-item-${route.mode}-${width}.png`,
        fullPage: true,
      });
    }
  }
});
