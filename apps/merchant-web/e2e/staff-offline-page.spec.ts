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

// b18: with the offline page gone from the cache (cleared storage, an unfinished install) the
// tablet still shows what to do, never a blank page.
test("@production a staff page reloaded offline without its cached offline page still says what to do", async ({
  page,
  context,
}) => {
  await page.goto("/operations/dining");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.evaluate(async () => {
    for (const name of await caches.keys()) await caches.delete(name);
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "无法连接门店系统" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The store system can't be reached" }),
  ).toBeVisible();
  await context.setOffline(false);
});
