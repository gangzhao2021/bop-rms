import { expect, test } from "@playwright/test";
// v15 aa3d9fac D3 (pilot rule "no reachable stubs"): the production workspace now sends this
// address to a working screen until the screen has real sources (checked for every route by
// pilot-routes.spec.ts); the layout it asserts stays in the local demo. Kept for the record.
test.skip(true, "v15 aa3d9fac D3: this screen is hidden in the production workspace");

test("@production Report Builder Review stays unavailable and responsive", async ({ page }) => {
  await page.goto("/app/reports/review/edit");
  await expect(page.getByText("RPT-REPORT-BUILDER · PHASE 3 · DESIGN REVIEW")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Report Builder", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Authorized report definition is unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Report definition", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approved sources" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule and delivery" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Validation and preview" })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(21);
  for (const field of await page.getByRole("textbox").all()) {
    await expect(field).toBeDisabled();
  }
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByText("Sample preview and row count · Unavailable")).toBeVisible();
  await expect(page.getByText("DAILY_SALES", { exact: true })).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/report-builder-${width}.png`, fullPage: true });
  }
});
