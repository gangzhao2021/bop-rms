import { expect, test, type Page } from "@playwright/test";

// WP-2423 Q35: a manager away from the counter sees refunds waiting for approval on every page.
const id = (n: number) => "0190996c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
function entry(n: number, state: "AwaitingApproval" | "Approved") {
  const now = Date.now();
  return {
    orderReference: id(n),
    orderNumber: "A-00" + String(40 + n),
    requestReference: id(100 + n),
    paymentIntentReferences: [id(200 + n)],
    paymentMethod: "Online",
    currencyCode: "CAD",
    amountMinor: "12500",
    reasonCode: "WRONG_ITEM",
    note: null,
    escalationReasons: ["OrderOrdinaryTotalAboveCad100"],
    requestedAt: new Date(now - 60_000).toISOString(),
    requesterName: "Mia",
    requestedByYou: false,
    requesterVerifiedUntil: new Date(now + 14 * 60_000).toISOString(),
    state,
    approvalReference: state === "Approved" ? id(300 + n) : null,
    approvedAt: state === "Approved" ? new Date(now - 30_000).toISOString() : null,
    approverName: state === "Approved" ? "Owner" : null,
    canApprove: true,
    soleOperatorApproval: false,
  };
}
async function session(page: Page, withApprovals: boolean) {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [
            { brandLabel: scope.brandLabel, storeLabel: scope.storeLabel, storeReference: id(99) },
          ],
          businessDate: "2026-10-25",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "OPS-ORDER-QUEUE",
              label: "Orders",
              href: "/operations/orders",
              permission: "ordering.operate",
            },
            ...(withApprovals
              ? [
                  {
                    screenId: "APPROVAL-INBOX",
                    label: "Approvals",
                    href: "/app/approvals",
                    permission: "workflow.operate",
                  },
                ]
              : []),
          ],
        },
      },
    }),
  );
}

test("@production refunds waiting for approval are counted on the home page and in the navigation", async ({
  page,
}) => {
  await session(page, true);
  let entries = [entry(1, "AwaitingApproval"), entry(2, "AwaitingApproval"), entry(3, "Approved")];
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: { observedAt: new Date().toISOString(), canApprove: true, soleOperator: null, entries },
    }),
  );
  await page.goto("/app");
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await expect(navigation.getByRole("link", { name: "Approvals 3 waiting" })).toBeVisible();
  const line = page.locator(".overview-counts li", { hasText: "Refunds waiting for approval" });
  await expect(line).toContainText("3");
  await expect(line).toContainText("2 to approve · 1 approved, not sent yet");
  await expect(line.getByRole("link", { name: "Review approvals" })).toHaveAttribute(
    "href",
    "/app/approvals",
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
  // Everything handled: the count goes away after the next read.
  entries = [];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(navigation.getByRole("link", { name: "Approvals", exact: true })).toBeVisible();
  await expect(line).toContainText("Nothing waiting");
});

test("@production staff without the approvals page are never asked for approvals", async ({
  page,
}) => {
  await session(page, false);
  const asked: string[] = [];
  await page.route("**/merchant/payments/refunds/approvals", (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 403, headers, json: {} });
  });
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Right now" })).toBeVisible();
  await expect(page.getByText("Refunds waiting for approval")).toHaveCount(0);
  expect(asked).toEqual([]);
});
