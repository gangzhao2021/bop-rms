import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

const id = (n: number) => "018f7700-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
const headers = { "cache-control": "no-store" };
const closedView = (businessDate: string) => ({
  screenId: "PAY-RECONCILIATION",
  storeLabel: scope.storeLabel,
  businessDate,
  window: {
    startsAt: `${businessDate}T08:00:00.000Z`,
    endsAt: "2026-09-22T08:00:00.000Z",
    timeZone: "America/Toronto",
    status: "Closed",
  },
  captured: { count: 14, amountMinor: "123450", currencyCode: "CAD" },
  refunded: { count: 1, amountMinor: "1130", currencyCode: "CAD" },
  selfApprovedRefunds: { count: 0, amountMinor: "0", currencyCode: "CAD" },
  reconciliation: {
    settlement: {
      run: {
        runReference: id(1),
        mode: "DailySettlement",
        scheduledAt: "2026-09-22T12:00:00.000Z",
        cutoffAt: "2026-09-22T12:00:00.000Z",
        completedAt: "2026-09-22T12:00:06.000Z",
        counts: { Matched: 1, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 0 },
      },
      checks: [
        {
          checkReference: id(2),
          runReference: id(1),
          checkedAt: "2026-09-22T12:00:05.000Z",
          outcome: "Matched",
          differenceReason: null,
          settlementReference: "SETTLE-2026-09-21-01",
          internalStatus: null,
          providerStatus: null,
          currencyCode: "CAD",
          internalCapturedMinor: "123450",
          providerCapturedMinor: "123450",
          internalRefundedMinor: "1130",
          providerRefundedMinor: "1130",
          exceptionReference: null,
        },
      ],
    },
    operational: {
      runCount: 240,
      latestRun: {
        runReference: id(4),
        mode: "Operational",
        scheduledAt: "2026-09-22T07:58:00.000Z",
        cutoffAt: "2026-09-22T07:58:00.000Z",
        completedAt: "2026-09-22T07:58:01.000Z",
        counts: { Matched: 13, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 1 },
      },
      paymentCount: 14,
      outcomes: { Matched: 13, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 1 },
    },
    differences: [
      {
        checkReference: id(5),
        runReference: id(4),
        checkedAt: "2026-09-22T07:58:00.700Z",
        outcome: "Difference",
        differenceReason: "RefundMismatch",
        settlementReference: null,
        internalStatus: "Captured",
        providerStatus: "Captured",
        currencyCode: "CAD",
        internalCapturedMinor: "1130",
        providerCapturedMinor: "1130",
        internalRefundedMinor: "0",
        providerRefundedMinor: "1130",
        exceptionReference: id(3),
      },
    ],
    differenceCount: 1,
  },
  projectedAt: "2026-09-22T09:00:00.000Z",
});

test("@production Settlement shows the day's totals, the run result and differences; denial fails closed", async ({
  page,
}) => {
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
          businessDate: "2026-09-22",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "PAY-RECONCILIATION",
              label: "Settlement",
              href: "/app/operations/payment-reconciliation",
              permission: "operations.order-exception.manage",
            },
          ],
        },
      },
    }),
  );
  const requested: (string | null)[] = [];
  let denied = false;
  await page.route("**/merchant/settlement*", (route) => {
    const date = new URL(route.request().url()).searchParams.get("businessDate");
    requested.push(date);
    if (denied) return route.fulfill({ status: 403, headers, json: { error: "request_denied" } });
    if (date === "2026-09-22")
      return route.fulfill({
        headers,
        json: {
          ...closedView("2026-09-22"),
          window: {
            startsAt: "2026-09-22T08:00:00.000Z",
            endsAt: "2026-09-22T15:00:00.000Z",
            timeZone: "America/Toronto",
            status: "Open",
          },
          reconciliation: {
            ...closedView("2026-09-22").reconciliation,
            settlement: null,
          },
        },
      });
    return route.fulfill({ headers, json: closedView(date ?? "2026-09-21") });
  });

  await page.goto("/app/operations/payment-reconciliation");
  await expect(page.getByRole("heading", { level: 1, name: "Settlement" })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Settlement" })
      .first(),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Business day: Mon, Sep 21" })).toBeVisible();
  await expect(page.getByText("$1,234.50", { exact: true })).toBeVisible();
  await expect(page.getByText("14 payments", { exact: true })).toBeVisible();
  await expect(page.getByText("$1,223.20")).toBeVisible();
  await expect(
    page.getByText("Settled · the day's totals match the provider statement"),
  ).toBeVisible();
  await expect(
    page.getByText(
      "14 payments checked in 240 runs · last Sep 22, 2026, 3:58 AM · 13 matched · 1 difference",
    ),
  ).toBeVisible();
  await expect(page.getByText("Difference · Refund differs")).toBeVisible();
  await expect(page.getByRole("link", { name: "Exceptions" })).toHaveAttribute(
    "href",
    "/operations/order-exceptions",
  );
  await expect(page.locator("body")).not.toContainText(id(1));
  expect(requested).toEqual([null]);
  // Staff read store-time wording, never a machine date, code or internal statement reference
  // (WP-2423 v15 showed "simset_20261014_9df991b5…"): the statement is named by its day.
  await expect(page.getByText("Provider statement for Mon, Sep 21")).toBeVisible();
  await expect(page.getByText("SETTLE-2026-09-21-01")).toHaveCount(0);
  await expectNoInternalText(page);

  // A day that is still open: totals so far, no run yet.
  await page.getByRole("textbox", { name: "Business day" }).fill("2026-09-22");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Business day: Tue, Sep 22" })).toBeVisible();
  await expect(page.getByText("Still open")).toBeVisible();
  await expect(page.getByText("after the business day closes", { exact: false })).toBeVisible();
  await expectNoInternalText(page);
  expect(requested.at(-1)).toBe("2026-09-22");
  await page.getByRole("button", { name: "Latest closed day" }).click();
  await expect(page.getByRole("heading", { name: "Business day: Mon, Sep 21" })).toBeVisible();

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await expect(page.getByText("Provider statement for Mon, Sep 21")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/settlement-${width}.png`, fullPage: true });
  }

  denied = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No access", exact: true })).toBeVisible();
  await expect(
    page.getByText("You don't have access to this page. Ask the owner or a manager."),
  ).toBeVisible();
  await expect(page.getByText("$1,234.50")).toHaveCount(0);
});

test("@production WP-2423 Settlement explains an open day difference and a day resolved by a re-check", async ({
  page,
}) => {
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
          businessDate: "2026-09-22",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "PAY-RECONCILIATION",
              label: "Settlement",
              href: "/app/operations/payment-reconciliation",
              permission: "operations.order-exception.manage",
            },
            {
              screenId: "OPS-ORDER-EXCEPTION",
              label: "Exceptions",
              href: "/operations/order-exceptions",
              permission: "operations.order-exception.manage",
            },
          ],
        },
      },
    }),
  );
  // The v15 Oct 9 shape: the store counted $0.00 in refunds, the provider $22.60 (the refund of
  // a charge that matched no order); after the fix the day is checked again and matches.
  let resolved = false;
  await page.route("**/merchant/settlement*", (route) => {
    const base = closedView("2026-09-21");
    const settlement = base.reconciliation.settlement;
    const first = {
      ...settlement.checks[0],
      outcome: "Difference",
      differenceReason: "RefundMismatch",
      settlementReference: "simset_20260921_" + "e".repeat(64),
      internalRefundedMinor: "1130",
      providerRefundedMinor: "3390",
      exceptionReference: id(3),
    };
    const recheckRun = {
      ...settlement.run,
      runReference: id(20),
      completedAt: "2026-09-23T16:00:01.000Z",
    };
    return route.fulfill({
      headers,
      json: {
        ...base,
        reconciliation: {
          ...base.reconciliation,
          settlement: {
            ...settlement,
            run: {
              ...settlement.run,
              counts: { ...settlement.run.counts, Matched: 0, Difference: 1 },
            },
            checks: [first],
            recheck: resolved
              ? {
                  run: recheckRun,
                  check: {
                    ...first,
                    checkReference: id(21),
                    runReference: id(20),
                    checkedAt: "2026-09-23T16:00:00.500Z",
                    outcome: "Matched",
                    differenceReason: null,
                    internalRefundedMinor: "3390",
                    exceptionReference: null,
                  },
                  count: 1,
                }
              : null,
          },
        },
        unmatchedProviderCharges: {
          captured: { count: 0, amountMinor: "0", currencyCode: "CAD" },
          refunded: { count: 1, amountMinor: "2260", currencyCode: "CAD" },
        },
      },
    });
  });
  await page.goto("/app/operations/payment-reconciliation");
  await expect(
    page.getByText("Settlement difference · the day's totals differ from the provider statement"),
  ).toBeVisible();
  const help = page.getByRole("note").filter({ hasText: "Refunds for this day differ" });
  await expect(help).toContainText(
    "The store's records show $11.30 in refunds; the payment provider's statement shows $33.90 ($22.60 more at the payment provider).",
  );
  await expect(help).toContainText("checked again automatically when new records arrive");
  await help.getByRole("link", { name: "Exceptions" }).click();
  await expect(page).toHaveURL(/\/operations\/order-exceptions$/u);
  await page.goBack();
  resolved = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Settled · the day's totals match the provider statement"),
  ).toBeVisible();
  await expect(page.getByText("First check of Mon, Sep 21")).toBeVisible();
  await expect(page.getByText("Checked again", { exact: true })).toBeVisible();
  await expect(page.getByText("so that difference is resolved", { exact: false })).toBeVisible();
  await expect(page.getByText("Refunds for this day differ")).toHaveCount(0);
  await expect(
    page.getByText("Refund of an unmatched provider charge: 1 refund · $22.60"),
  ).toBeVisible();
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/settlement-recheck-${width}.png`, fullPage: true });
  }
});

test("@production WP-2423 Settlement keeps a day settled twice readable and answers a day before the store's records", async ({
  page,
}) => {
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
          businessDate: "2026-09-22",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "PAY-RECONCILIATION",
              label: "Settlement",
              href: "/app/operations/payment-reconciliation",
              permission: "operations.order-exception.manage",
            },
          ],
        },
      },
    }),
  );
  // v15 Sep 20: the day was settled once by a run outside its schedule (earlier) and once by the
  // scheduled run; both matched. v15 Sep 19: before the store started using the system.
  const requested: (string | null)[] = [];
  await page.route("**/merchant/settlement*", (route) => {
    const date = new URL(route.request().url()).searchParams.get("businessDate");
    requested.push(date);
    if (date === "2026-09-19")
      return route.fulfill({
        status: 404,
        headers,
        json: { error: "settlement_not_covered", firstBusinessDate: "2026-09-20" },
      });
    const base = closedView("2026-09-20");
    const settlement = base.reconciliation.settlement;
    const scheduled = settlement.checks[0];
    return route.fulfill({
      headers,
      json: {
        ...base,
        reconciliation: {
          ...base.reconciliation,
          settlement: {
            ...settlement,
            recheck: null,
            additionalChecks: [
              {
                ...scheduled,
                checkReference: id(31),
                runReference: id(30),
                checkedAt: "2026-09-22T11:22:18.000Z",
              },
            ],
          },
        },
      },
    });
  });
  await page.goto("/app/operations/payment-reconciliation?businessDate=2026-09-20");
  await expect(page.getByRole("heading", { name: "Business day: Sun, Sep 20" })).toBeVisible();
  await expect(
    page.getByText("Settled · the day's totals match the provider statement"),
  ).toBeVisible();
  await expect(page.getByText("Earlier check of Sun, Sep 20")).toBeVisible();
  await expect(page.getByText("Provider statement for Sun, Sep 20")).toBeVisible();
  await expect(page.getByText("Reconciliation records could not be read.")).toHaveCount(0);
  await expectNoInternalText(page);
  expect(requested).toEqual(["2026-09-20"]);

  await page.getByRole("textbox", { name: "Business day" }).fill("2026-09-19");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No settlement records for this day" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Sat, Sep 19 is before the store started using this system/),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "No access", exact: true })).toHaveCount(0);
  await expectNoInternalText(page);
  await page.getByRole("button", { name: "Show Sun, Sep 20" }).click();
  await expect(page.getByRole("heading", { name: "Business day: Sun, Sep 20" })).toBeVisible();
  expect(requested).toEqual(["2026-09-20", "2026-09-19", "2026-09-20"]);
});
