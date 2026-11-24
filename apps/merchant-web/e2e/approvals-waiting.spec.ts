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
  // WP-2423 M07: the Approvals badge also counts staff roles waiting for this person; none wait.
  // Answered here so the badge never races a failed read ("could not be counted").
  await page.route("**/merchant/organization/staff/role-requests", (route) =>
    route.fulfill({
      headers,
      json: { screenId: "APPROVAL-INBOX", sourceAsOf: new Date().toISOString(), requests: [] },
    }),
  );
  await page.route("**/merchant/organization/roles/waiting", (route) =>
    route.fulfill({
      headers,
      json: { screenId: "APPROVAL-INBOX", sourceAsOf: new Date().toISOString(), changes: [] },
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
      json: {
        observedAt: new Date().toISOString(),
        canApprove: true,
        canSend: true,
        soleOperator: null,
        entries,
      },
    }),
  );
  await page.goto("/app");
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await expect(navigation.getByRole("link", { name: "Approvals 3 waiting" })).toBeVisible();
  const line = page.locator(".overview-attention li", { hasText: "Refunds waiting for approval" });
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
  await expect(page.getByRole("heading", { name: "Right now" })).toBeVisible();
  await expect(line).toHaveCount(0);
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

test("@production a cashier's home and badge never count refunds they can neither approve nor send", async ({
  page,
}) => {
  // v15 batch 5: a cashier's approvals read lists the store's requests; Home said "1 to approve ·
  // 1 approved, not sent yet" and the badge counted them, though a cashier can do neither.
  await session(page, true);
  const entries = [entry(1, "AwaitingApproval"), entry(2, "Approved")].map((e) => ({
    ...e,
    canApprove: false,
  }));
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: false,
        canSend: false,
        soleOperator: null,
        entries,
      },
    }),
  );
  await page.goto("/app");
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await expect(navigation.getByRole("link", { name: "Approvals", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Right now" })).toBeVisible();
  await expect(page.getByText("Refunds waiting for approval")).toHaveCount(0);
  await expect(page.getByText("To approve", { exact: true })).toHaveCount(0);
});

// Batch 57 (v15 b56 live, /app/approvals in zh: "大额或逾期的退款需要另一人批准。 为什么需要批准？"):
// the plain JSX space between the two sentences put a space after the Chinese full stop.
for (const language of ["en", "zh-Hans"] as const)
  test(`@production the refund approvals line joins its two sentences in the language's own way (${language})`, async ({
    page,
  }) => {
    if (language === "zh-Hans")
      await page.addInitScript(() =>
        window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
      );
    await session(page, true);
    await page.route("**/merchant/payments/refunds/approvals", (route) =>
      route.fulfill({
        headers,
        json: {
          observedAt: new Date().toISOString(),
          canApprove: true,
          canSend: true,
          soleOperator: null,
          entries: [entry(1, "AwaitingApproval")],
        },
      }),
    );
    await page.goto("/app/approvals");
    const summary = page.locator(".approvals-why summary");
    await expect(summary).toHaveText(
      language === "en"
        ? "Large or late refunds need a second person. Why approval?"
        : "大额或逾期的退款需要另一人批准。为什么需要批准？",
    );
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(summary).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      // Wrapped, never clipped, with room left for the wider DejaVu fonts of Linux CI.
      const box = await summary.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      expect(
        await summary.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
    }
  });
