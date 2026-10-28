import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { storeReportsViewFixture } from "../src/store-reports.fixtures.js";

/**
 * WP-2423 Q14 (RPT-OPS-DASHBOARD): the Owner/Store Manager reads the Store's sales reports for the
 * current business day or a range, downloads each report as CSV, and is refused without permission.
 * Synthetic test-only figures; the server answers are routed in the browser.
 */
const id = (n: number) => "018f7730-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
const headers = { "cache-control": "no-store" };
const nowAt = "2026-10-14T23:00:00.000Z"; // 19:00 in Toronto

test.use({ timezoneId: "America/Toronto" });

test("@production Reports show sales, items, hours and tips for a period, download CSV, and fail closed", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(nowAt));
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
          businessDate: "2026-10-14",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "PAY-RECONCILIATION",
              label: "Settlement",
              href: "/app/operations/payment-reconciliation",
              permission: "payment.settlement.read",
            },
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
        businessDate: "2026-10-14",
        startsAt: "2026-10-14T08:00:00.000Z",
        endsAt: "2026-10-15T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: nowAt,
      },
    }),
  );
  const requested: string[] = [];
  let denied = false;
  await page.route("**/merchant/reports?*", (route) => {
    const url = new URL(route.request().url());
    requested.push(`${url.searchParams.get("from")}..${url.searchParams.get("to")}`);
    if (denied) return route.fulfill({ status: 403, headers, json: { error: "request_denied" } });
    return route.fulfill({ headers, json: storeReportsViewFixture() });
  });
  const exports: string[] = [];
  await page.route("**/merchant/reports/export?*", (route) => {
    const url = new URL(route.request().url());
    exports.push(url.search);
    return route.fulfill({
      headers: {
        ...headers,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="items-2026-10-13-to-2026-10-14.csv"',
      },
      body: "﻿business_date,item,quantity_sold\r\n2026-10-14,Muffin,4\r\n",
    });
  });

  await page.goto("/app/reports/operations");
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Reports" })
      .first(),
  ).toHaveAttribute("aria-current", "page");
  // WP-2423 item 8 ②: the page opens on tonight's summary; the period reports are one tab over.
  await expect(page.getByRole("button", { name: "Tonight", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Sales by period" }).click();
  // Opens on the Store's current business day.
  await expect.poll(() => requested[0]).toBe("2026-10-14..2026-10-14");
  // v15 store-day L6: the range includes today's open day, so it is checked at day end.
  await expect(
    page.getByText("Today is checked against it when the day closes.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sales summary" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Sales by payment" })).toContainText(
    "Store card machine",
  );
  await expect(page.getByRole("table", { name: "Sales by order type" })).toContainText("Counter");
  await expect(page.getByRole("table", { name: "Item sales" })).toContainText("Latte — Large");
  await expect(page.getByRole("table", { name: "Sales by hour" })).toContainText("11:00");
  await expect(
    page.getByText("does not record which staff member earned them", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("018f7730-");

  // Quick period: the last seven business days.
  await page.getByRole("button", { name: "Last 7 days" }).click();
  await expect.poll(() => requested.at(-1)).toBe("2026-10-08..2026-10-14");
  // A period past today's business day cannot be asked for.
  await page.getByLabel("To", { exact: true }).fill("2026-10-15");
  await expect(page.getByRole("button", { name: "Show", exact: true })).toBeDisabled();
  await page.getByLabel("To", { exact: true }).fill("2026-10-14");

  // Download a report as CSV.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download item sales as CSV" }).click();
  expect((await download).suggestedFilename()).toBe("items-2026-10-13-to-2026-10-14.csv");
  expect(exports.at(-1)).toBe("?report=items&from=2026-10-08&to=2026-10-14");

  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("heading", { name: "Item sales" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/store-reports-${width}.png`, fullPage: true });
  }

  denied = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No access", exact: true })).toBeVisible();
  await expect(
    page.getByText("You don't have access to this page. Ask the owner or a manager."),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "Item sales" })).toHaveCount(0);
});
