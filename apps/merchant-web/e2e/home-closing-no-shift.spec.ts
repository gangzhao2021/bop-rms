import { expect, test } from "@playwright/test";
import { tonightSummaryFixture } from "../src/tonight-summary.fixtures.js";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 34 (Pickup's pattern, checked on Home): the evening reminder at the top of Home depends on
 * the Store's hours for the day, read apart from Home's own reads. Home used to show its sections
 * first and insert the reminder above them once the hours arrived, pushing everything down; it
 * now waits for that read, so Home's sections never show without the reminder. Synthetic HTTP
 * interception on the production build, TEST-only data.
 */
const id = (n: number) => "018f7731-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
const headers = { "cache-control": "no-store" };
const evening = "2026-10-28T01:42:00.000Z"; // 21:42 in Toronto, business day 2026-10-27

test.use({ timezoneId: "America/Toronto" });

test("@production in the evening Home shows its reminder with its sections, not after them", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(evening));
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-10-27",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "RPT-OPS-DASHBOARD",
              label: "Reports",
              href: "/app/reports/operations",
              permission: "reporting.sales.read",
            },
          ],
        },
      },
    }),
  );
  // The day's hours arrive after Home's own reads.
  await page.route("**/merchant/business-day", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-27",
        startsAt: "2026-10-27T08:00:00.000Z",
        endsAt: "2026-10-28T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: evening,
      },
    });
  });
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({ headers, json: tonightSummaryFixture() }),
  );
  await page.addInitScript(() => {
    const samples: { today: boolean; reminder: boolean }[] = [];
    (window as unknown as { homeSamples: typeof samples }).homeSamples = samples;
    const sample = () => {
      if (document.querySelector("main .overview-now") !== null)
        samples.push({
          today: true,
          reminder: document.querySelector("main .closing-reminder") !== null,
        });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto("/app");
  await expect(page.getByRole("region", { name: "Before closing" })).toBeVisible();
  await page.waitForTimeout(500);
  const seen = await page.evaluate(
    () =>
      (window as unknown as { homeSamples: { today: boolean; reminder: boolean }[] }).homeSamples,
  );
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((entry) => entry.reminder)).toBe(true);
  await expectNoInternalText(page);
});
