import { expect, test } from "@playwright/test";

test("@production PRIVACY-REQUEST keeps the Phase 3 disabled workflow source-limited at desktop and mobile widths", async ({
  page,
}) => {
  await page.goto("/app/compliance/privacy-requests");
  await expect(page.getByRole("heading", { name: "COMPLIANCE" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Privacy rights requests" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Privacy Request disabled" })).toBeVisible();
  await expect(page.getByText("Phase 3 disabled", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Requests are not available" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Owner actions disabled" })).toBeVisible();

  const filters = page.getByRole("group", { name: "Filters" });
  for (const label of [
    "Case ref / verified contact",
    "Rights type",
    "Status",
    "Owner",
    "Due / overdue",
    "Brand",
  ]) {
    const controls = filters.locator("label").filter({ hasText: label }).locator("input, select");
    await expect(controls).toHaveCount(1);
    await expect(controls).toBeDisabled();
  }
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(
    page.getByText("Filters stay disabled while the Phase 3 capability is disabled.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/No sample case, contact, owner or rights data is shown\./),
  ).toBeVisible();

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
    await page.screenshot({
      path: `test-results/privacy-request-review-${width}.png`,
      fullPage: true,
    });
  }
});
