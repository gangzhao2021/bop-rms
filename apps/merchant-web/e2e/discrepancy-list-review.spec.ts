import { expect, test } from "@playwright/test";

test("@production PROC-DISCREPANCY keeps unavailable case facts fail-closed responsively", async ({
  page,
}) => {
  await page.goto("/app/supply/discrepancies");
  await expect(
    page.getByRole("heading", { name: "Receiving discrepancies", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Discrepancy projection unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Case, variance and resolution status" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Discrepancies unavailable" })).toBeVisible();
  const filters = page.getByRole("group", { name: "Search and filters" });
  await expect(filters).toBeVisible();
  for (const label of [
    "PO, receipt or supplier reference filter unavailable",
    "Discrepancy type, status or Stock Site filter unavailable",
    "Discrepancy owner or overdue filter unavailable",
  ])
    await expect(filters.getByLabel(label)).toBeDisabled();
  await expect(page.getByText("No authorized case rows are available.")).toBeVisible();
  await expect(
    page.getByText(/Synthetic|DEMO-|\bCAD\b|Correction promised|\+?\d{3}[ -]?\d{3}[ -]?\d{4}/u),
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
    await page.screenshot({ path: `test-results/discrepancy-list-${width}.png`, fullPage: true });
  }
});
