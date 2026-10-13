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
  await page.route("**/merchant/payments/refunds/progress", (route) =>
    route.fulfill({
      headers,
      json: {
        requestReference: id(2),
        progress: refunded ? "Refunded" : "Sending",
        observedAt: new Date().toISOString(),
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

  const itemReads: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/merchant/payments/refunds/items")) itemReads.push(request.url());
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
  // The Approvals page follows progress with its own small read, never the request item list.
  expect(itemReads).toEqual([]);
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

// WP-2423 Q5: an owner opens a refunded payment: state, history with status, no request form.
for (const pending of [false, true])
  test(
    "@production owner sees refund history of a " +
      (pending ? "pending" : "fully refunded") +
      " payment",
    async ({ page }) => {
      const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      const scope = {
        brandLabel: "Synthetic Brand",
        storeLabel: "Synthetic Store",
        storeReference: id(99),
        timeZone: "America/Toronto",
      };
      const headers = { "cache-control": "no-store" };
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
                {
                  brandLabel: scope.brandLabel,
                  storeLabel: scope.storeLabel,
                  storeReference: id(99),
                },
              ],
              businessDate: "2026-10-12",
              storeStatus: "Open",
              freshness: "Current",
              dashboardAvailability: "UnavailableUntilWP1905",
              navigation: [],
            },
          },
        }),
      );
      await page.route("**/merchant/payments/refunds/context", (route) =>
        route.fulfill({
          headers,
          json: {
            paymentIntentReference: id(31),
            paymentAttemptReference: id(32),
            orderReference: id(1),
            orderBatchReference: id(90),
            observedAt: "2026-10-12T15:00:00.000Z",
            paymentState: "Captured",
            currencyCode: "CAD",
            capturedAmountMinor: "1130",
            confirmedRefundMinor: pending ? "0" : "1130",
            pendingRefundMinor: pending ? "1130" : "0",
            canRequest: false,
          },
        }),
      );
      await page.route("**/merchant/payments/refunds/items", (route) =>
        route.fulfill({
          headers,
          json: {
            orderReference: id(1),
            orderNumber: "ORD-7",
            canRequest: false,
            claimVersion: 1,
            recentRequests: [
              {
                requestReference: id(40),
                operationReference: id(41),
                claimVersion: 1,
                requestedAt: "2026-10-12T14:00:00.000Z",
                reasonCode: "WRONG_ITEM",
                currencyCode: "CAD",
                amountMinor: "1130",
                decline: null,
                progress: pending ? "Sending" : "Refunded",
              },
            ],
            items: [],
          },
        }),
      );
      await page.route("**/merchant/payments/refunds/approvals", (route) =>
        route.fulfill({
          headers,
          json: { observedAt: "2026-10-12T15:00:00.000Z", canApprove: true, entries: [] },
        }),
      );
      await page.goto("/app/operations/payments/" + id(31));
      await expect(
        page.getByText(pending ? "Payment state: Paid, refund pending" : "Payment state: Refunded"),
      ).toBeVisible();
      await expect(
        page.getByText(
          pending
            ? "A refund of CAD 11.30 is pending; nothing more can be requested until it finishes."
            : "Nothing is left to refund on this payment.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Open Approvals" })).toHaveAttribute(
        "href",
        "/app/approvals",
      );
      await expect(page.getByRole("link", { name: "Start refund request" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Recorded refund requests" })).toContainText(
        pending ? "Sent — result pending" : "Refunded",
      );
      await expect(page.getByRole("group", { name: "Refund selection" })).toHaveCount(0);
      // The /refund route shows the same state, never the item and reason form.
      await page.goto("/app/operations/payments/" + id(31) + "/refund");
      await expect(
        page.getByText(pending ? "is pending; nothing more" : "Nothing is left to refund", {
          exact: false,
        }),
      ).toBeVisible();
      await expect(page.getByRole("group", { name: "Refund selection" })).toHaveCount(0);
    },
  );
