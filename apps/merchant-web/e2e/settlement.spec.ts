import { expect, test } from "@playwright/test";

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
  reconciliation: {
    runs: [
      {
        runReference: id(1),
        mode: "DailySettlement",
        scheduledAt: "2026-09-22T08:05:00.000Z",
        cutoffAt: "2026-09-22T08:00:00.000Z",
        completedAt: "2026-09-22T08:06:00.000Z",
        counts: { Matched: 13, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 1 },
      },
    ],
    differences: [
      {
        checkReference: id(2),
        runReference: id(1),
        checkedAt: "2026-09-22T08:05:30.000Z",
        outcome: "Difference",
        differenceReason: "RefundMismatch",
        settlementReference: "SETTLE-2026-09-21-01",
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
          reconciliation: { runs: [], differences: [] },
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
  await expect(page.getByRole("heading", { name: "Business day 2026-09-21" })).toBeVisible();
  await expect(page.getByText("$1,234.50")).toBeVisible();
  await expect(page.getByText("14 payments")).toBeVisible();
  await expect(page.getByText("$1,223.20")).toBeVisible();
  await expect(
    page.getByText("1 difference · 0 unresolved · 0 unavailable · 13 matched"),
  ).toBeVisible();
  await expect(page.getByText("Difference · Refund differs")).toBeVisible();
  await expect(page.getByRole("link", { name: "Exceptions" })).toHaveAttribute(
    "href",
    "/operations/order-exceptions",
  );
  await expect(page.locator("body")).not.toContainText(id(1));
  expect(requested).toEqual([null]);

  // A day that is still open: totals so far, no run yet.
  await page.getByRole("textbox", { name: "Business day" }).fill("2026-09-22");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Business day 2026-09-22" })).toBeVisible();
  await expect(page.getByText("Still open")).toBeVisible();
  await expect(page.getByText("after the business day closes", { exact: false })).toBeVisible();
  expect(requested.at(-1)).toBe("2026-09-22");
  await page.getByRole("button", { name: "Latest closed day" }).click();
  await expect(page.getByRole("heading", { name: "Business day 2026-09-21" })).toBeVisible();

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await expect(page.getByText("SETTLE-2026-09-21-01")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/settlement-${width}.png`, fullPage: true });
  }

  denied = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Permission denied" })).toBeVisible();
  await expect(page.getByText("$1,234.50")).toHaveCount(0);
});
