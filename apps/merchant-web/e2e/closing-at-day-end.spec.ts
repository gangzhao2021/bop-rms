import { expect, test, type Page } from "@playwright/test";
import { tonightSummaryFixture } from "../src/tonight-summary.fixtures.js";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 48 (v15 batch 47 live check, item 4 "partly"): no v15 Store's last period ends exactly as
 * its business day ends, and the live run fell outside the closing hour, so the Home and Tables
 * closing wording for such a Store was only unit tested. Here, on the production build with a
 * fixed clock and the /merchant/business-day shape v15 sends:
 * - a late-night Store open 18:00–04:00, business day from 04:00 (closesAt = endsAt, openAtDayEnd
 *   false), is reminded on Home from 03:00, and Tables says "Closing at 04:00" / "04:00 打烊" (batch 64: the staff clock);
 * - a Store open 24 hours (TM2: closesAt = endsAt, openAtDayEnd true) never sees the reminder.
 * Synthetic HTTP interception, TEST-only data.
 */
const id = (n: number) => "018f9f48-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Late Night Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
// Business day Sat Nov 21, 2026, 04:00 to 04:00 Toronto (EST, UTC-5).
const startsAt = "2026-11-21T09:00:00.000Z";
const endsAt = "2026-11-22T09:00:00.000Z";
/** Toronto wall-clock time on the night of Nov 21 → 22 (hour 0–3 is Nov 22). */
const toronto = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 10, hour < 4 ? 22 : 21, hour + 5, minute));

async function mock(page: Page, language: "en" | "zh-Hans", openAtDayEnd: boolean, now: Date) {
  await page.clock.setFixedTime(now);
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      window.localStorage.setItem("bop.merchant.language", "zh-Hans");
    });
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-21",
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
            {
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
          ],
        },
      },
    }),
  );
  // As v15 sends it: the last period ends with the business day, so closesAt equals endsAt; only
  // openAtDayEnd tells a Store open 24 hours from one that closes at 4:00.
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-11-21",
        startsAt,
        endsAt,
        timeZone: "America/Toronto",
        observedAt: now.toISOString(),
        lastOrdersAt: openAtDayEnd ? "2026-11-22T04:34:59.000Z" : "2026-11-22T08:30:00.000Z",
        closesAt: endsAt,
        closedToday: false,
        openAtDayEnd,
      },
    }),
  );
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({ headers, json: tonightSummaryFixture() }),
  );
  const table = (n: number, label: string) => ({
    tableReference: id(n),
    stableLabel: label,
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 2,
    currentDiningSessionReference: id(10 + n),
    elapsedMinutes: 30,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: [],
    staffCall: null,
  });
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: false,
        canTransferHost: false,
        canCancelUnpaidRounds: false,
        items: [table(1, "H3"), table(2, "H4")],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/staff-calls/count", (route) =>
    route.fulfill({ headers, json: { open: 0 } }),
  );
}

/** Home has shown its sections: whatever reminder it has is on screen by now. */
async function openHome(page: Page) {
  await page.goto("/app");
  await expect(page.locator("main .overview-now")).toBeVisible();
}

const reminder = (page: Page, zh: boolean) =>
  page.getByRole("region", { name: zh ? "打烊前" : "Before closing" });

for (const language of ["en", "zh-Hans"] as const) {
  const zh = language === "zh-Hans";
  test.describe(`@production batch 48 closing at the end of the business day (${language})`, () => {
    test.use({ timezoneId: "America/Toronto", locale: "en-CA" });

    test("a Store open 18:00–04:00 is not reminded at 2:59, is reminded from 3:00", async ({
      page,
    }) => {
      await mock(page, language, false, toronto(2, 59));
      await openHome(page);
      await expect(page.locator("main .closing-reminder")).toHaveCount(0);
      await page.clock.setFixedTime(toronto(3, 0));
      await page.reload();
      await openHome(page);
      await expect(reminder(page, zh)).toBeVisible();
      await expectNoInternalText(page);
    });

    for (const width of [390, 1024, 1440]) {
      test(`at 3:30 Home reminds it and Tables says it closes at 4:00, at ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await mock(page, language, false, toronto(3, 30));
        await openHome(page);
        await expect(reminder(page, zh)).toBeVisible();
        await page.goto("/operations/dining");
        await expect(
          page.getByText(
            zh
              ? /^04:00 打烊：还有 2 张?桌/u
              : /^Closing at 04:00: 2 tables still open\. Take each table's payment and close it when the guests leave\.$/u,
          ),
        ).toBeVisible();
        await expect(page.getByText(zh ? /营业日 .* 结束/u : /business day ends/u)).toHaveCount(0);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
        await expectNoInternalText(page);
        await page.screenshot({
          path: `test-results/b48-closing-at-day-end-${language}-${width}.png`,
        });
      });
    }

    test("a Store open 24 hours sees no closing reminder at any hour", async ({ page }) => {
      await mock(page, language, true, toronto(4, 30));
      for (const [hour, minute] of [
        [4, 30],
        [12, 0],
        [21, 0],
        [23, 30],
        [3, 0],
        [3, 30],
        [3, 59],
      ] as const) {
        await page.clock.setFixedTime(toronto(hour, minute));
        await openHome(page);
        await expect(page.locator("main .closing-reminder")).toHaveCount(0);
      }
      // Tables, in the day's last hour, speaks of the day's end, not of closing.
      await page.goto("/operations/dining");
      await expect(
        page.getByText(
          zh
            ? /^营业日 04:00 结束：还有 2/u
            : /^The business day ends at 04:00: 2 tables still open\./u,
        ),
      ).toBeVisible();
      await expect(page.getByText(zh ? /打烊：/u : /^Closing at/u)).toHaveCount(0);
    });
  });
}
