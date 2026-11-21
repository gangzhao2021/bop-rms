import { expect, test } from "@playwright/test";
// v15 aa3d9fac D3 (pilot rule "no reachable stubs"): the production workspace now sends this
// address to a working screen until the screen has real sources (checked for every route by
// pilot-routes.spec.ts); the layout it asserts stays in the local demo. Kept for the record.
test.skip(true, "v15 aa3d9fac D3: this screen is hidden in the production workspace");

test("@production Reporting Catalog Review stays unavailable and responsive", async ({ page }) => {
  await page.goto("/app/reports");
  await expect(page.getByRole("heading", { name: "OPERATIONS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await expect(page.getByText("RPT-REPORT-CATALOG · PHASE 2 · DESIGN REVIEW")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Authorized report catalog unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Create report" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "View" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Run" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Duplicate" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Archive" })).toBeDisabled();
  await expect(
    page.getByText(/No reports are shown until a scoped Business Intelligence projection/u),
  ).toBeVisible();
  await expect(page.getByText("DAILY_SALES", { exact: true })).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/report-catalog-${width}.png`, fullPage: true });
  }
});
