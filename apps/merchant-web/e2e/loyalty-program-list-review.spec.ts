import { expect, test } from "@playwright/test";

test("@production LOY-PROGRAM-LIST preserves the Phase 3 source boundary at desktop and mobile widths", async ({
  page,
}) => {
  await page.goto("/app/customers/loyalty-programs");
  await expect(page.getByRole("heading", { name: "OPERATIONS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Loyalty Programs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Phase 3 capability disabled" })).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Loyalty Programs Phase 3 capability disabled" }),
  ).toBeVisible();
  await expect(
    page.getByText("No program records are shown while the Phase 3 capability is disabled."),
  ).toBeVisible();
  const filters = page.getByRole("group", { name: "Filters" });
  await expect(filters).toBeVisible();
  await expect(
    filters.getByRole("textbox", { name: "Name or code filter unavailable" }),
  ).toBeDisabled();
  for (const label of [
    "Status filter unavailable",
    "Store scope filter unavailable",
    "Scheduled filter unavailable",
  ])
    await expect(filters.getByLabel(label)).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Program catalog" })).toBeVisible();
  await expect(page.getByText("No program data available")).toBeVisible();
  await expect(page.getByText("Synthetic Rewards")).toHaveCount(0);
  await expect(page.getByText("Members 10")).toHaveCount(0);

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
      path: `test-results/loyalty-program-list-${width}.png`,
      fullPage: true,
    });
  }
});
