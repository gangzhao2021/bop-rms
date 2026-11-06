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
  await expect(page.getByRole("button", { name: "Today's summary", exact: true })).toHaveAttribute(
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

/**
 * WP-2423 M160 (v15 2026-11-06): Fireside Hotpot started using the system at 20:51 on business day
 * 11-05. Its first day reads and is marked, a period asked from before it starts there and says
 * so, and a period wholly before it is an answer with a way to the first day, in English and
 * Simplified Chinese. Synthetic test-only figures; the server answers are routed in the browser.
 */
for (const language of ["en", "zh-Hans"] as const)
  test(`@production Reports for a Store's first business day and the days before it (${language})`, async ({
    page,
  }) => {
    const words =
      language === "en"
        ? {
            period: "Sales by period",
            yesterday: "Yesterday",
            week: "Last 7 days",
            show: "Show",
            from: "From",
            to: "To",
            firstDay: "First day · from 20:51",
            begins: "Records begin on Thu, Nov 5. Days before that have no sales",
            none: "No sales in this period",
            why: "The store started using this system on Thu, Nov 5, so there are no sales before then.",
            showFrom: "Show from Thu, Nov 5",
          }
        : {
            period: "按时段报表",
            yesterday: "昨天",
            week: "最近 7 天",
            show: "显示",
            from: "从",
            to: "至",
            firstDay: "第一天 · 20:51 起",
            begins: "记录从",
            none: "这段时间没有销售",
            why: "门店从",
            showFrom: "开始显示",
          };
    if (language === "zh-Hans")
      await page.addInitScript(() => {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      });
    const at = "2026-11-06T23:00:00.000Z"; // 18:00 in Toronto on business day 11-06
    await page.clock.setFixedTime(new Date(at));
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
            businessDate: "2026-11-06",
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
          businessDate: "2026-11-06",
          startsAt: "2026-11-06T09:00:00.000Z",
          endsAt: "2026-11-07T09:00:00.000Z",
          timeZone: "America/Toronto",
          observedAt: at,
        },
      }),
    );
    const base = storeReportsViewFixture();
    const [closed, open] = base.days as Record<string, unknown>[];
    const opensAt = "2026-11-06T01:51:48.000Z"; // 20:51 on 11-05 in Toronto
    const first = {
      ...closed,
      businessDate: "2026-11-05",
      startsAt: "2026-11-05T09:00:00.000Z",
      endsAt: "2026-11-06T09:00:00.000Z",
      opensAt,
    };
    const today = {
      ...open,
      businessDate: "2026-11-06",
      startsAt: "2026-11-06T09:00:00.000Z",
      endsAt: at,
      opensAt: null,
    };
    const view = (from: string, to: string, requestedFrom: string, days: unknown[]) => ({
      ...base,
      from,
      to,
      requestedFrom,
      recordsBeginOn: requestedFrom < from ? from : null,
      startsAt: "2026-11-05T09:00:00.000Z",
      endsAt: to === "2026-11-06" ? at : "2026-11-06T09:00:00.000Z",
      includesOpenDay: to === "2026-11-06",
      days,
      tips: [],
    });
    const requested: string[] = [];
    await page.route("**/merchant/reports?*", (route) => {
      const url = new URL(route.request().url());
      const from = url.searchParams.get("from") ?? "",
        to = url.searchParams.get("to") ?? "";
      requested.push(`${from}..${to}`);
      if (to < "2026-11-05")
        return route.fulfill({
          status: 404,
          headers,
          json: { error: "reports_not_covered", firstBusinessDate: "2026-11-05" },
        });
      const covered = from < "2026-11-05" ? "2026-11-05" : from;
      return route.fulfill({
        headers,
        json: view(
          covered,
          to,
          from,
          [first, today].filter(
            (day) => String(day.businessDate) >= covered && String(day.businessDate) <= to,
          ),
        ),
      });
    });

    await page.goto("/app/reports/operations");
    await page.getByRole("button", { name: words.period }).click();
    await expect.poll(() => requested[0]).toBe("2026-11-06..2026-11-06");

    // Yesterday is the Store's first business day: its figures, marked as the first day.
    await page.getByRole("button", { name: words.yesterday, exact: true }).click();
    await expect.poll(() => requested.at(-1)).toBe("2026-11-05..2026-11-05");
    await expect(page.getByText(words.firstDay, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("table", { name: /Sales by payment|按付款方式销售/u }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(words.begins);

    // The last 7 days start before the Store: the period starts on its first day and says so.
    await page.getByRole("button", { name: words.week }).click();
    await expect.poll(() => requested.at(-1)).toBe("2026-10-31..2026-11-06");
    await expect(page.getByRole("note").filter({ hasText: words.begins })).toBeVisible();

    // A month wholly before the Store is an answer with the way to its first day.
    await page.getByLabel(words.from, { exact: true }).fill("2026-10-01");
    await page.getByLabel(words.to, { exact: true }).fill("2026-10-31");
    await page.getByRole("button", { name: words.show, exact: true }).click();
    await expect.poll(() => requested.at(-1)).toBe("2026-10-01..2026-10-31");
    await expect(page.getByRole("heading", { name: words.none })).toBeVisible();
    await expect(page.getByText(words.why, { exact: false })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/Reports unavailable|报表暂时读不到/u);
    await expect(page.locator("body")).not.toContainText(/reports_not_covered|018f7730-/u);

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
      await expect(page.getByRole("heading", { name: words.none })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/store-reports-before-records-${language}-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // "Show from {date}": the same 31 days from the first day, ending no later than today.
    await page.getByRole("button", { name: new RegExp(words.showFrom, "u") }).click();
    await expect.poll(() => requested.at(-1)).toBe("2026-11-05..2026-11-06");
    await expect(page.getByRole("note").filter({ hasText: words.begins })).toHaveCount(0);
    await expect(page.getByRole("table", { name: /Sales by day|按天销售/u })).toContainText(
      words.firstDay,
    );
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/store-reports-first-day-${language}-${width}.png`,
        fullPage: true,
      });
    }
  });
