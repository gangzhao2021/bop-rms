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
    note: null,
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
  // A second card waiting for the same owner: one verification must serve both.
  const second = {
    ...entry,
    orderReference: id(11),
    orderNumber: "A-0044",
    requestReference: id(12),
    paymentIntentReferences: [id(13)],
  };
  let listed = [entry, second];
  let refunded = false;
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        orderNumber: "A-0042",
        canRequest: false,
        claimVersion: 1,
        items: [],
        recentRequests: [
          {
            requestReference: id(2),
            operationReference: id(6),
            claimVersion: 1,
            requestedAt: entry.requestedAt,
            reasonCode: "WRONG_ITEM",
            currencyCode: "CAD",
            amountMinor: "12500",
            decline: null,
            progress: refunded ? "Refunded" : "Sending",
          },
        ],
      },
    }),
  );
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
    if (route.request().method() === "GET")
      return route.fulfill({ headers, json: { validUntil: null } });
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
        payments: [{ paymentAttemptReference: id(4), operationReference: id(5), state: "Sending" }],
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
  // Verified: no code entry is offered again until the verification runs out.
  await expect(card.getByRole("button", { name: "Verify to approve" })).toHaveCount(0);
  await expect(card).toContainText("Verified until");
  await expect(page.getByLabel("Six-digit code").first()).toHaveValue("");

  await approve.click();
  await expect(card.getByRole("alert")).toContainText("Mia must confirm it is them again");
  // The other card uses the same person's verification at once.
  const secondCard = page.getByRole("listitem").filter({ hasText: "Order A-0044" });
  await expect(secondCard.getByRole("button", { name: "Verify to approve" })).toHaveCount(0);
  await expect(
    secondCard.getByRole("button", { name: "Approve and refund CAD 125.00" }),
  ).toBeEnabled();
  // Each card's code field has its own id (labels stay associated).
  const ids = await page
    .locator('input[name="one-time-code"]')
    .evaluateAll((inputs) => inputs.map((input) => input.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThan(1);
  await approve.click();
  await expect(card).toContainText(
    "Approved. Refund sent to the payment provider — result pending",
  );
  refunded = true;
  await expect(card).toContainText("Refunded to the customer's original payment method.", {
    timeout: 15_000,
  });
  expect(approvals).toHaveLength(2);
  expect(approvals[1]).toBe(approvals[0]);
  expect(JSON.parse(approvals[0] ?? "{}")).toMatchObject({
    orderReference: id(1),
    requestReference: id(2),
  });
  await card.getByRole("button", { name: "Refresh list" }).click();
  await expect(page.getByText("No refund at this store is waiting for approval.")).toBeVisible();
});

// WP-2423 Q5: the owner declines a request (with the requester's "Other" note shown).
test("@production owner declines a refund with a reason and it leaves the list", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  const now = Date.now();
  let listed = [
    {
      orderReference: id(1),
      orderNumber: "A-0043",
      requestReference: id(2),
      paymentIntentReferences: [id(3)],
      currencyCode: "CAD",
      amountMinor: "11600",
      reasonCode: "OTHER",
      note: "Customer left before the food arrived",
      escalationReasons: ["OrderOrdinaryTotalAboveCad100"],
      requestedAt: new Date(now - 60_000).toISOString(),
      requesterName: "Mia",
      requestedByYou: false,
      requesterVerifiedUntil: null,
      state: "AwaitingApproval",
      approvalReference: null,
      approvedAt: null,
      approverName: null,
      canApprove: true,
    },
  ];
  const declines: string[] = [];
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
    if (route.request().method() === "GET")
      return route.fulfill({ headers, json: { validUntil: null } });
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
  await page.route("**/merchant/payments/refunds/decline", (route) => {
    declines.push(route.request().postData() ?? "");
    listed = [];
    return route.fulfill({
      headers,
      json: { status: "Declined", declinedAt: new Date().toISOString(), replayed: false },
    });
  });
  await page.goto("/app/approvals");
  const card = page.getByRole("listitem").filter({ hasText: "Order A-0043" });
  await expect(card).toContainText("Customer left before the food arrived");
  await expect(card).toContainText("Needs to verify again before approval");
  const declineButton = card.getByRole("button", { name: "Decline refund" });
  await card.getByLabel("Decline reason").selectOption("NEEDS_MORE_INFORMATION");
  await expect(declineButton).toBeDisabled();
  await card.getByRole("button", { name: "Verify to approve" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("246810");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await declineButton.click();
  await expect(card).toContainText("Declined — nothing was refunded");
  expect(JSON.parse(declines[0] ?? "{}")).toMatchObject({
    orderReference: id(1),
    requestReference: id(2),
    reasonCode: "NEEDS_MORE_INFORMATION",
  });
  await card.getByRole("button", { name: "Refresh list" }).click();
  await expect(page.getByText("No refund at this store is waiting for approval.")).toBeVisible();
});
