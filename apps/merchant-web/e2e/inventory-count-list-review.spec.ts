import { expect, test } from "@playwright/test";
// WP-2423 pilot: this route is now the Store's working page (stock counts / supply items under
// WP-2423 inventory operations); the "Phase 2 source boundary" placeholders this spec asserts no
// longer exist. Kept for the record; coverage of the working pages lives in their unit tests.
test.skip(true, "WP-2423 pilot: the placeholder page this spec asserts was replaced");

test("@production INV-COUNT-LIST presents unavailable fields and commands without sample facts", async ({
  page,
}) => {
  await page.goto("/operations/inventory/counts");
  await expect(page.getByRole("heading", { name: "Inventory Counts", level: 2 })).toBeVisible();
  await expect(page.getByRole("status", { name: "Count projection unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Count status and execution" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Count list unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Count unavailable" })).toBeDisabled();
  const filters = page.getByRole("group", { name: "Search and filters" });
  for (const label of [
    "Count ref / Store scope filter",
    "Status / type / assignee filter",
    "Due / variance / overdue filter",
  ])
    await expect(filters.getByLabel(label)).toBeDisabled();
  await expect(page.getByText("No authorized count records are available.")).toBeVisible();
  await expect(
    page.getByText(/Synthetic|DEMO-|018fa700|Authorized count assignee|\b\d+\/\d+\b/u),
  ).toHaveCount(0);
  await expect(
    page.getByText("Create, assign, start, submit, approve/reject and cancel remain unavailable"),
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
      path: `test-results/inventory-count-list-${width}.png`,
      fullPage: true,
    });
  }
});
