import { expect, test } from "@playwright/test";

test("@production COMMS-HISTORY keeps the Figma review hierarchy source-limited at desktop and mobile widths", async ({
  page,
}) => {
  await page.goto("/app/customers/communications");
  await expect(page.getByRole("heading", { name: "CUSTOMERS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Communication history" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Communication disabled" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "History unavailable" })).toBeVisible();
  await expect(
    page.getByText("No sample recipients, templates or Provider outcomes are shown."),
  ).toBeVisible();

  const filters = page.getByRole("group", { name: "Filters" });
  await expect(filters).toBeVisible();
  await expect(filters.getByLabel("Source / permitted recipient")).toBeDisabled();
  await expect(filters.getByLabel("Classification")).toBeDisabled();
  await expect(filters.getByLabel("Channel")).toBeDisabled();
  await expect(filters.getByLabel("Provider state")).toBeDisabled();
  await expect(filters.getByLabel("Date range")).toBeDisabled();
  await expect(filters.getByLabel("Suppression")).toBeDisabled();

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 920 });
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          className: element.className,
          tag: element.tagName,
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }))
        .slice(0, 8),
    }));
    expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({ path: `test-results/comms-history-${width}.png`, fullPage: true });
  }
});
