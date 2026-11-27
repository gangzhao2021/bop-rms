import { expect, test } from "@playwright/test";
// WP-2423 pilot: this route is now the Store's working page (stock counts / supply items under
// WP-2423 inventory operations); the "Phase 2 source boundary" placeholders this spec asserts no
// longer exist. Kept for the record; coverage of the working pages lives in their unit tests.
test.skip(true, "WP-2423 pilot: the placeholder page this spec asserts was replaced");

test("@production INV-COUNT-WORKBENCH keeps blind-count facts and commands unavailable responsively", async ({
  page,
}) => {
  await page.goto("/operations/inventory/counts/test-count");
  await expect(
    page.getByRole("heading", { name: "Stock Count Workbench", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Count workbench projection unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText("Blind expected quantities stay hidden until authorized submission."),
  ).toBeVisible();
  const filters = page.getByRole("group", { name: "Line search and filters" });
  for (const label of [
    "Item or barcode search unavailable",
    "Line / counted status filter unavailable",
    "Variance / recount filter unavailable",
  ])
    await expect(filters.getByLabel(label)).toBeDisabled();
  const actions = page.getByRole("group", { name: "Count actions unavailable" });
  for (const label of [
    "Scan or enter quantity",
    "Save progress",
    "Recount",
    "Submit count",
    "Approve / reject",
    "Post Movements",
  ])
    await expect(actions.getByRole("button", { name: label })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Count lines unavailable" })).toBeVisible();
  await expect(
    page.getByText(/Synthetic|DEMO-|test-count|018fa700|ITEM_\d|\b\d+\s*(KG|EA)\b/u),
  ).toHaveCount(0);

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
      path: `test-results/inventory-count-workbench-${width}.png`,
      fullPage: true,
    });
  }
});
