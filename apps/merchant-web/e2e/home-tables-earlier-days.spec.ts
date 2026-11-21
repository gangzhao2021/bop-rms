import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { notPausedServiceControl } from "./service-control-state";
import { tonightSummaryFixture } from "../src/tonight-summary.fixtures.js";

/**
 * b40 (v15 b39 live, Fireside Hotpot at 01:08 after closing): Home's Needs attention said "Tables
 * to close · 8 tables served" and "Open tables 8" for eight tables left open two weeks before, and
 * never showed "Tables still open from earlier days", while Tables kept them apart. The unit tests
 * handed the day's start to the rows directly; Home itself passed null. Here Home gets the day only
 * the way it does on v15: from the shell's business-day read (the v15 answer's shape, closesAt and
 * all), with an owner's navigation that includes Reports, so the closing reminder reads too.
 * Synthetic, TEST-only data.
 */
const id = (n: number) => "019a4001-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
// 01:08 in Toronto: the Store closed at 00:00, its business day (Fri) ends at 04:00.
const now = "2026-11-21T06:08:00.000Z";
const businessDay = {
  businessDate: "2026-11-20",
  startsAt: "2026-11-20T09:00:00.000Z",
  endsAt: "2026-11-21T09:00:00.000Z",
  timeZone: "America/Toronto",
  observedAt: now,
  lastOrdersAt: null,
  closesAt: "2026-11-21T05:00:00.000Z",
  closedToday: false,
};

test.use({ timezoneId: "America/Toronto" });

function table(n: number, label: string, elapsedMinutes: number, extra: object = {}) {
  return {
    tableReference: id(n),
    stableLabel: label,
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 4,
    currentDiningSessionReference: id(100 + n),
    elapsedMinutes,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    paymentTiming: "PayLater",
    session: { phase: "Closing", version: 5, orderReference: id(200 + n) },
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: [],
    staffCall: null,
    ...extra,
  };
}

async function home(page: Page, language: "en" | "zh-Hans", todaySeated: boolean) {
  await page.clock.setFixedTime(new Date(now));
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        /* the page falls back to English */
      }
    });
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
          businessDate: businessDay.businessDate,
          storeStatus: "Closed",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            ["OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"],
            ["FUL-PICKUP-QUEUE", "Pickup", "/operations/pickup", "fulfillment.operate"],
            [
              "OPS-ORDER-EXCEPTION",
              "Exceptions",
              "/operations/order-exceptions",
              "operations.order-exception.manage",
            ],
            ["DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"],
            ["KIT-KITCHEN-QUEUE", "Kitchen", "/operations/kitchen", "kitchen.operate"],
            ["RPT-OPS-DASHBOARD", "Reports", "/app/reports/operations", "reporting.sales.read"],
          ].map(([screenId, label, href, permission]) => ({ screenId, label, href, permission })),
        },
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({ headers, json: businessDay }),
  );
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: notPausedServiceControl(scope.storeReference) }),
  );
  await page.route("**/merchant/operations-alerts", (route) =>
    route.fulfill({
      headers,
      json: {
        monitor: "Reporting",
        observedAt: now,
        active: [],
        recentlyCleared: [],
        outbound: { email: false, webhooks: 0, heartbeat: false },
        lastSuccessfulBackupAt: "2026-11-21T05:30:00.000Z",
      },
    }),
  );
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-EXCEPTION",
        projectionName: "merchant_order_exception_v1",
        storeLabel: scope.storeLabel,
        businessDate: businessDay.businessDate,
        projectedAt: now,
        freshnessStatus: "Fresh",
        items: [],
      },
    }),
  );
  await page.route("**/merchant/pickup/query", (route) =>
    route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: scope.storeReference,
        observedAt: now,
        nextAfterFulfillmentReference: null,
        items: [],
      },
    }),
  );
  // As on v15: eight tables seated 14–15 days ago and never closed (one with a round held since
  // then), and, in the second case, one table seated this evening that still owes.
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: true,
        canTransferHost: true,
        canCancelUnpaidRounds: true,
        nextAfterTableReference: null,
        items: [
          table(1, "5", 21_640, {
            session: { phase: "Active", version: 3, orderReference: id(201) },
            heldRounds: [
              {
                orderReference: id(201),
                orderBatchReference: id(301),
                roundNumber: 3,
                heldAt: "2026-11-06T23:00:00.000Z",
                reason: "PhoneRapid",
              },
            ],
          }),
          table(2, "1", 21_600),
          table(3, "3", 21_590),
          table(4, "Booth 8", 21_580),
          table(5, "2", 21_570),
          table(6, "PC 9", 21_560),
          table(7, "LB08S Test", 20_300, {
            session: { phase: "Active", version: 2, orderReference: id(207) },
          }),
          table(8, "SRS Test", 20_250, {
            session: { phase: "Active", version: 2, orderReference: id(208) },
          }),
          ...(todaySeated
            ? [
                table(9, "H1", 95, {
                  session: { phase: "Active", version: 2, orderReference: id(209) },
                }),
              ]
            : []),
          table(10, "H2", 0, {
            currentDiningSessionReference: null,
            elapsedMinutes: null,
            session: null,
          }),
        ],
      },
    }),
  );
  const fixture = tonightSummaryFixture();
  const report = fixture.report as Record<string, unknown>;
  const earlier = [
    ["5", "9596", 21_640, "Owes"],
    ["1", "0", 21_600, "Paid"],
    ["3", "0", 21_590, "Paid"],
    ["Booth 8", "0", 21_580, "Paid"],
    ["2", "0", 21_570, "Paid"],
    ["PC 9", "0", 21_560, "Paid"],
    ["LB08S Test", "677", 20_300, "Owes"],
    ["SRS Test", "4399", 20_250, "Owes"],
  ] as const;
  const openTables = [
    ...earlier.map(([tableLabel, owedMinor, openedMinutes, standing]) => ({
      tableLabel,
      phase: standing === "Paid" ? "Closing" : "Active",
      paymentTiming: "PayLater",
      owedMinor,
      openedMinutes,
      standing,
    })),
    ...(todaySeated
      ? [
          {
            tableLabel: "H1",
            phase: "Active",
            paymentTiming: "PayLater",
            owedMinor: "4520",
            openedMinutes: 95,
            standing: "Owes",
          },
        ]
      : []),
  ];
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({
      headers,
      json: {
        ...fixture,
        // The day as v15 reports it: from the business day's start to now.
        report: {
          ...report,
          from: businessDay.businessDate,
          to: businessDay.businessDate,
          startsAt: businessDay.startsAt,
          endsAt: now,
          generatedAt: now,
        },
        openTables,
        openTablesOwedMinor: String(
          openTables.reduce((sum, entry) => sum + Number(entry.owedMinor), 0),
        ),
      },
    }),
  );
}

for (const language of ["en", "zh-Hans"] as const)
  test(`@production b40: after closing Home keeps two-week-old tables apart from tonight's, in ${language}`, async ({
    page,
  }) => {
    await home(page, language, false);
    await page.goto("/app");
    const zh = language === "zh-Hans";
    const needs = page.getByRole("region", { name: zh ? "需要处理" : "Needs attention" });
    await expect(needs).toBeVisible();
    const row = needs.locator(".overview-attention > li", {
      hasText: zh ? "之前营业日没关的桌" : "Tables still open from earlier days",
    });
    await expect(row).toBeVisible();
    await expect(row).toContainText(zh ? "8 张桌台" : "8 tables");
    // Not tonight's tables to close: no table was seated today.
    await expect(needs).not.toContainText(zh ? "待关闭的桌台" : "Tables to close");
    // After closing with none of today's tables owing, the reminder still names them with what
    // they owe (b39 left this case blank).
    const reminder = page.getByRole("region", { name: zh ? "打烊后" : "After closing" });
    if (zh) {
      await expect(reminder).toContainText("打烊后：今天的桌都结完了");
      await expect(reminder).toContainText("之前营业日开的，还没关 · $146.72，不计入今天的数字");
    } else {
      await expect(reminder).toContainText("After closing: today's tables are all paid");
      await expect(reminder).toContainText(
        "Also open from earlier days: 8 tables · $146.72, not in today's figures.",
      );
    }
    // "Right now" counts tonight's open tables (none) and says the earlier ones apart.
    const count = page.locator(".overview-counts li", {
      has: page.getByRole("link", { name: zh ? "开着的桌台" : "Open tables" }),
    });
    await expect(count.locator(".overview-count__value")).toHaveText("0");
    await expect(count).toContainText(
      zh ? "不计入：8 张桌台是之前营业日的" : "Not counted: 8 tables from earlier days",
    );
    await expectNoInternalText(page);
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/b40-home-earlier-days-${language}-${width}.png`,
        fullPage: true,
      });
    }
  });

test("@production b40: a table seated tonight still counts and owes; the earlier ones stay apart", async ({
  page,
}) => {
  await home(page, "en", true);
  await page.goto("/app");
  const needs = page.getByRole("region", { name: "Needs attention" });
  await expect(
    needs.locator(".overview-attention > li", { hasText: "Tables still open from earlier days" }),
  ).toContainText("8 tables");
  const reminder = page.getByRole("region", { name: "After closing" });
  await expect(reminder).toContainText("After closing: 1 table not paid yet · $45.20");
  await expect(reminder).toContainText("Also open from earlier days: 8 tables · $146.72");
  const count = page.locator(".overview-counts li", {
    has: page.getByRole("link", { name: "Open tables" }),
  });
  await expect(count.locator(".overview-count__value")).toHaveText("1");
});
