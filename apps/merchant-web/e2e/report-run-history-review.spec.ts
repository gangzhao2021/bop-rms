import { expect, test } from "@playwright/test";

test("@production Report Run History Review stays unavailable and responsive", async ({ page }) => {
  await page.goto("/app/reports/runs");
  await expect(page.getByText("BOP", { exact: true })).toBeVisible();
  await expect(page.getByText("OPERATIONS", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Report Run history" })).toBeVisible();
  await expect(page.getByText("RPT-RUN-HISTORY · PHASE 2–3 · DESIGN REVIEW")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Authorized run history is unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(6);
  for (const filter of await page.getByRole("textbox").all()) {
    await expect(filter).toBeDisabled();
  }
  await expect(page.getByRole("columnheader")).toHaveCount(8);
  await expect(page.getByRole("cell", { name: "No run rows shown" })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByText(/parameterSnapshotDigest|requesterReference|sha256:/iu)).toHaveCount(
    0,
  );
  await expect(page.getByText(/https?:\/\//iu)).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/report-run-history-${width}.png`, fullPage: true });
  }
});
