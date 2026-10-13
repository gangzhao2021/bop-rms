import { expect, test } from "@playwright/test";

// WP-2423 Q5: an owner approves an escalated refund in person (APPROVAL-INBOX /app/approvals).
test("@production owner verifies and approves a refund above CAD 100 once", async ({ page }) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  const now = Date.now();
  const entry = {
    orderReference: id(1),
    orderNumber: "A-0042",
    requestReference: id(2),
    paymentIntentReferences: [id(3)],
    currencyCode: "CAD",
    amountMinor: "12500",
    reasonCode: "WRONG_ITEM",
    escalationReasons: ["OrderOrdinaryTotalAboveCad100"],
    requestedAt: new Date(now - 60_000).toISOString(),
    requesterName: "Mia",
    requestedByYou: false,
    requesterVerifiedUntil: new Date(now + 14 * 60_000).toISOString(),
    state: "AwaitingApproval",
    approvalReference: null,
    approvedAt: null,
    approverName: null,
    canApprove: true,
  };
  let listed = [entry];
  const stepUps: string[] = [],
    approvals: string[] = [];
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
          businessDate: "2026-10-12",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "APPROVAL-INBOX",
              label: "Approvals",
              href: "/app/approvals",
              permission: "workflow.operate",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: { observedAt: new Date(now).toISOString(), canApprove: true, entries: listed },
    }),
  );
  await page.route("**/merchant/identity/step-up", (route) => {
    stepUps.push(route.request().postData() ?? "");
    const at = Date.now();
    return route.fulfill({
      headers,
      json: {
        status: "Verified",
        verifiedAt: new Date(at).toISOString(),
        validUntil: new Date(at + 15 * 60_000).toISOString(),
      },
    });
  });
  await page.route("**/merchant/payments/refunds/approve", (route) => {
    approvals.push(route.request().postData() ?? "");
    if (approvals.length === 1)
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "needs_reverification", party: "Requester" },
      });
    listed = [];
    return route.fulfill({
      status: 202,
      headers,
      json: {
        status: "Approved",
        approvalReference: JSON.parse(approvals[0] ?? "{}").approvalReference,
        replayed: false,
        payments: [
          { paymentAttemptReference: id(4), operationReference: id(5), state: "SendRecorded" },
        ],
      },
    });
  });

  await page.goto("/app/approvals");
  await expect(page.getByRole("link", { name: "Approvals" }).first()).toBeVisible();
  const card = page.getByRole("listitem").filter({ hasText: "Order A-0042" });
  await expect(card).toContainText("CAD 125.00");
  await expect(card).toContainText("Wrong item");
  await expect(card).toContainText("Mia");
  await expect(card).toContainText("Refunds on this order would total more than CAD 100");
  await expect(card).toContainText("Waiting for approval");
  const approve = card.getByRole("button", { name: "Approve and refund CAD 125.00" });
  await expect(approve).toBeDisabled();

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/refund-approval-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await card.getByRole("button", { name: "Verify to approve" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  expect(JSON.parse(stepUps[0] ?? "{}")).toEqual({ purpose: "RefundApproval", code: "123456" });
  await expect(page.getByLabel("Six-digit code").first()).toHaveValue("");

  await approve.click();
  await expect(card.getByRole("alert")).toContainText("Mia must confirm it is them again");
  await approve.click();
  await expect(card).toContainText("Approved and sent to the customer's original payment method.");
  expect(approvals).toHaveLength(2);
  expect(approvals[1]).toBe(approvals[0]);
  expect(JSON.parse(approvals[0] ?? "{}")).toMatchObject({
    orderReference: id(1),
    requestReference: id(2),
  });
  await card.getByRole("button", { name: "Refresh list" }).click();
  await expect(page.getByText("No refund at this store is waiting for approval.")).toBeVisible();
});
