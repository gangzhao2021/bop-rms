import { expect, test } from "@playwright/test";

// WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): a Brand Owner running the business alone turns sole
// operator on, then approves their own refund after confirming it (APPROVAL-INBOX /app/approvals).
test("@production a sole operator turns it on and approves their own refund after confirming", async ({
  page,
}) => {
  const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
    orderNumber: "A-0051",
    requestReference: id(2),
    paymentIntentReferences: [id(3)],
    paymentMethod: "Online",
    currencyCode: "CAD",
    amountMinor: "11600",
    reasonCode: "WRONG_ITEM",
    note: null,
    escalationReasons: ["DifferentBusinessDate"],
    requestedAt: new Date(now - 60_000).toISOString(),
    requesterName: "Sam",
    requestedByYou: true,
    requesterVerifiedUntil: null,
    state: "AwaitingApproval",
    approvalReference: null,
    approvedAt: null,
    approverName: null,
    canApprove: false,
    soleOperatorApproval: false,
  };
  let setting = {
    observedAt: new Date(now).toISOString(),
    state: "Off",
    version: 0,
    history: [] as unknown[],
    refundApproval: { status: "NotSet", youHoldApproval: true, otherApprovers: [] as unknown[] },
    verifiedUntil: null,
    reasons: {
      On: ["OWNER_RUNS_STORE_ALONE"],
      Off: ["SECOND_APPROVER_AVAILABLE", "OWNER_CHOICE", "ENTERED_IN_ERROR"],
    },
  };
  let soleOperator: "Effective" | "NotSet" = "NotSet";
  const changes: string[] = [],
    stepUps: string[] = [],
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
          businessDate: "2026-10-13",
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
      json: {
        observedAt: new Date().toISOString(),
        canApprove: true,
        soleOperator,
        entries: [
          soleOperator === "Effective"
            ? { ...entry, canApprove: true, soleOperatorApproval: true }
            : entry,
        ],
      },
    }),
  );
  await page.route("**/merchant/organization/sole-operator", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ headers, json: setting });
    changes.push(route.request().postData() ?? "");
    const at = new Date().toISOString();
    setting = {
      ...setting,
      state: "On",
      version: 1,
      history: [
        {
          version: 1,
          state: "On",
          reasonCode: "OWNER_RUNS_STORE_ALONE",
          recordedAt: at,
          changedByYou: true,
          changedByName: "Sam",
        },
      ],
      refundApproval: { status: "Effective", youHoldApproval: true, otherApprovers: [] },
    };
    soleOperator = "Effective";
    return route.fulfill({
      headers,
      json: { status: "Created", state: "On", version: 1, recordedAt: at },
    });
  });
  // The server's own record: once verified, every read reports the same verification.
  let validUntil: string | null = null;
  await page.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ headers, json: { validUntil } });
    stepUps.push(route.request().postData() ?? "");
    const at = Date.now();
    validUntil = new Date(at + 15 * 60_000).toISOString();
    return route.fulfill({
      headers,
      json: {
        status: "Verified",
        verifiedAt: new Date(at).toISOString(),
        validUntil: new Date(at + 15 * 60_000).toISOString(),
      },
    });
  });
  await page.route("**/merchant/payments/refunds/progress", (route) =>
    route.fulfill({
      headers,
      json: { requestReference: id(2), progress: "Refunded", observedAt: new Date().toISOString() },
    }),
  );
  await page.route("**/merchant/payments/refunds/approve", (route) => {
    approvals.push(route.request().postData() ?? "");
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
  const section = page.getByRole("region", { name: "Sole operator" });
  await expect(section).toContainText("Off. Refunds that need approval are approved by a second");
  const card = page.getByRole("listitem").filter({ hasText: "Order A-0051" });
  await expect(card).toContainText("An owner or finance member who did not ask for this refund");
  const turnOn = section.getByRole("button", { name: "Turn on sole operator" });
  await expect(turnOn).toBeDisabled();
  await section.getByLabel("Reason for turning it on").selectOption("OWNER_RUNS_STORE_ALONE");
  await expect(turnOn).toBeDisabled();
  await section.getByRole("button", { name: "Verify to turn it on" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  expect(JSON.parse(stepUps[0] ?? "{}")).toEqual({
    purpose: "SoleOperatorSetting",
    code: "123456",
  });
  await turnOn.click();
  await expect(section).toContainText("On and in effect: you are the only person");
  expect(JSON.parse(changes[0] ?? "{}")).toMatchObject({
    state: "On",
    reasonCode: "OWNER_RUNS_STORE_ALONE",
    expectedVersion: 0,
  });

  // The list refreshes: the owner may now approve their own request after confirming it.
  const ownCard = page.getByRole("listitem").filter({ hasText: "Order A-0051" });
  await expect(ownCard).toContainText("you are the only person who can approve refunds");
  const approve = ownCard.getByRole("button", { name: "Approve my own refund of CAD 116.00" });
  await expect(approve).toBeDisabled();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/sole-operator-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await ownCard.getByLabel("I checked this refund and approve it on my own").check();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(ownCard).toContainText("Refunded to the customer's original payment method.", {
    timeout: 15_000,
  });
  expect(JSON.parse(approvals[0] ?? "{}")).toMatchObject({
    orderReference: id(1),
    requestReference: id(2),
    approvalMode: "SoleOperator",
  });
});

// WP-2423 Q19: when someone else holds refund approval, the section says who and why.
test("@production sole operator not in effect names the other approver", async ({ page }) => {
  const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const headers = { "cache-control": "no-store" };
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
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
          businessDate: "2026-10-13",
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
      json: {
        observedAt: new Date().toISOString(),
        canApprove: true,
        soleOperator: null,
        entries: [],
      },
    }),
  );
  await page.route("**/merchant/identity/step-up", (route) =>
    route.fulfill({ headers, json: { validUntil: null } }),
  );
  await page.route("**/merchant/organization/sole-operator", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        state: "On",
        version: 1,
        history: [],
        refundApproval: {
          status: "OtherApprovers",
          youHoldApproval: true,
          otherApprovers: [{ displayName: "Mia" }],
        },
        verifiedUntil: null,
        reasons: { On: ["OWNER_RUNS_STORE_ALONE"], Off: ["OWNER_CHOICE"] },
      },
    }),
  );
  await page.goto("/app/approvals");
  const section = page.getByRole("region", { name: "Sole operator" });
  await expect(section).toContainText(
    "On, but not in effect: Mia also holds refund approval at this store, so a second person is required.",
  );
  await expect(section.getByRole("button", { name: "Turn off sole operator" })).toBeDisabled();
});
