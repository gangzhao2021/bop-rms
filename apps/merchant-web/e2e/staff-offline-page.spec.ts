import { expect, test } from "@playwright/test";

/**
 * Owner 2026-11-03 (operating continuity): a staff page opened while the connection is down shows
 * what to do and each table's last bill, never the browser's error page, and returns by itself.
 */
test("@production a staff page reloaded while offline shows the steps and the last bills", async ({
  page,
  context,
}) => {
  await page.goto("/operations/dining");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    localStorage.setItem("bop.merchant.language", "en");
    localStorage.setItem(
      "bop.tables.lastBills.v1",
      JSON.stringify({
        savedAt: new Date().toISOString(),
        tables: [
          {
            label: "T2",
            owedMinor: "2685",
            settled: false,
            rounds: [
              {
                number: 1,
                totalMinor: "2685",
                items: [{ name: "Mapo tofu", subtotalMinor: "1588" }],
              },
            ],
          },
        ],
      }),
    );
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "While the connection is down" })).toBeVisible();
  await expect(page.getByText("Table T2")).toBeVisible();
  await expect(page.getByText("To pay $26.85")).toBeVisible();
  await page.getByText("Table T2").click();
  await expect(page.getByText("Mapo tofu")).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByRole("heading", { name: "While the connection is down" })).toHaveCount(0);
});
