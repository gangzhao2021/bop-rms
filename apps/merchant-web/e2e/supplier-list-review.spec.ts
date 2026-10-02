import { expect, test } from "@playwright/test";

test("@production SUP-SUPPLIER-LIST keeps unavailable Supplier and contact facts fail-closed responsively", async ({
  page,
}) => {
  await page.goto("/app/supply/suppliers");
  await expect(page.getByRole("heading", { name: "Suppliers", level: 1 })).toBeVisible();
  await expect(page.getByRole("status", { name: "Supplier projection unavailable" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Supplier, qualification and performance" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Suppliers unavailable" })).toBeVisible();
  const filters = page.getByRole("group", { name: "Search and filters" });
  await expect(filters).toBeVisible();
  for (const label of [
    "Supplier name, code or approved contact reference filter unavailable",
    "Supplier status, type or qualification filters unavailable",
    "Supplier performance or open Purchase Order filters unavailable",
  ])
    await expect(filters.getByLabel(label)).toBeDisabled();
  await expect(page.getByText("No authorized Supplier rows are available.")).toBeVisible();
  await expect(
    page.getByText(/Synthetic|DEMO-|@[a-z]|\bCAD\b|\+?\d{3}[ -]?\d{3}[ -]?\d{4}/u),
  ).toHaveCount(0);
  await expect(
    page.getByText("Create, suspension/reactivation and archive are unavailable."),
  ).toBeVisible();

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          className: element.className,
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }))
        .slice(0, 8),
    }));
    expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({
      path: `test-results/supplier-list-${width}.png`,
      fullPage: true,
    });
  }
});
