import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { tonightSummaryFixture } from "../src/tonight-summary.fixtures.js";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 8 ② (Figma 47-2): at closing the Owner or Store Manager sees tonight's figures —
 * sales, what each payment method took (card-machine batch check, the drawer's table cash), the
 * tables still open and tonight's cancellations — and a reminder on Home in the evening. If the
 * store system can't be reached, the last figures stay with what to do. Synthetic figures.
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

async function workspace(page: Page) {
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
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-27",
        startsAt: "2026-10-27T08:00:00.000Z",
        endsAt: "2026-10-28T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: evening,
      },
    }),
  );
}

test("@production tonight's summary adds up, checks the card machine and drawer, lists open tables, and keeps its figures offline", async ({
  page,
}) => {
  await workspace(page);
  let reachable = true;
  let reads = 0;
  await page.route("**/merchant/reports/tonight", (route) => {
    reads += 1;
    if (!reachable) return route.abort("internetdisconnected");
    return route.fulfill({ headers, json: tonightSummaryFixture() });
  });
  await page.goto("/app/reports/operations");
  await expect(page.getByRole("button", { name: "Tonight", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("heading", { name: "Tonight · Tue, Oct 27" })).toBeVisible();
  const sales = page.getByRole("region", { name: /^Sales/u });
  await expect(sales).toContainText("Gross sales$412.50");
  await expect(sales).toContainText("Comps and discounts by a manager3 dishes−$18.25");
  await expect(sales).toContainText("Net sales$394.25");
  const takings = page.getByRole("region", { name: /^Taken, by payment method/u });
  await expect(takings.getByRole("table")).toContainText("Card machine8$27.40$219.50");
  await expect(takings).toContainText("Table cash that should be in the drawer$86.95");
  await expect(takings).toContainText("Total taken$503.05");
  await expect(takings).toContainText("Net taken$491.05");
  await expect(takings).toContainText("The batch total should be $219.50");
  await expect(takings).toContainText(
    "The cash drawer also holds cash taken on your own register.",
  );
  const open = page.getByRole("region", { name: /^Tables not paid yet/u });
  await expect(open).toContainText("2 tables · $86.40 to take before closing");
  await expect(open.getByRole("link", { name: "Go to Tables" })).toHaveAttribute(
    "href",
    /\/operations\/dining$/u,
  );
  await expect(page.getByRole("region", { name: /^Refunds and cancellations/u })).toContainText(
    "Dishes taken off a bill before payment2 dishes$18.80",
  );
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/tonight-summary-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);

  // The store system can't be reached: the last figures stay, with their time and what to do.
  reachable = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const offline = page.getByRole("status", { name: "Can't reach the store system" });
  await expect(offline).toContainText("showing the figures from 21:42");
  await expect(offline).toContainText("check the card machine's batch and the drawer's table cash");
  await expect(sales).toContainText("Net sales$394.25");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/tonight-summary-offline-390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  reachable = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(offline).toHaveCount(0);
  expect(reads).toBe(3);
});

test("@production in the evening Home reminds the manager what is still open and links to tonight", async ({
  page,
}) => {
  await workspace(page);
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({ headers, json: tonightSummaryFixture() }),
  );
  await page.goto("/app");
  const reminder = page.getByRole("region", { name: "Before closing" });
  await expect(reminder).toContainText("Before closing: 2 tables not paid yet · $86.40");
  await expect(reminder).toContainText("Tonight's net taken $491.05");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await reminder.screenshot({ path: `test-results/closing-reminder-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await reminder.getByRole("link", { name: "See tonight" }).click();
  await expect(page.getByRole("heading", { name: "Tonight · Tue, Oct 27" })).toBeVisible();
});
