import { expect, test } from "@playwright/test";

test("@production PROC-REQUISITION-LIST keeps unavailable facts fail-closed responsively", async ({
  page,
}) => {
  await page.goto("/app/supply/requisitions");
  await expect(
    page.getByRole("heading", { name: "Purchase requisitions", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Requisition projection unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Request, approval and allocation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Purchase requisitions unavailable" }),
  ).toBeVisible();
  const filters = page.getByRole("group", { name: "Search and filters" });
  await expect(filters).toBeVisible();
  for (const label of [
    "Requisition reference or Item filter unavailable",
    "Requisition status, Store or Requester filters unavailable",
    "Requisition urgency, allocation or date filters unavailable",
  ])
    await expect(filters.getByLabel(label)).toBeDisabled();
  await expect(page.getByText("No authorized Requisition rows are available.")).toBeVisible();
  await expect(page.getByText(/Synthetic|DEMO-|\bCAD\b|Requester [0-9a-f]{8}/u)).toHaveCount(0);

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
      path: `test-results/requisition-list-${width}.png`,
      fullPage: true,
    });
  }
});
