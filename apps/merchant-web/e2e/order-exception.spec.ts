import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

const stores = [1, 2].map((n) => ({
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store " + n,
  storeReference: "018f8100-0000-7000-8000-00000000000" + n,
}));
const workspace = (index: number) => ({
  screenId: "HOME-OVERVIEW",
  selectedScope: stores[index],
  authorizedStores: stores,
  businessDate: "2026-08-12",
  storeStatus: "Unavailable",
  freshness: "Stale",
  dashboardAvailability: "UnavailableUntilWP1905",
  navigation: [
    {
      screenId: "OPS-ORDER-EXCEPTION",
      label: "Order exceptions",
      href: "/operations/order-exceptions",
      permission: "operations.order-exception.manage",
    },
  ],
});
const view = (index: number) => ({
  screenId: "OPS-ORDER-EXCEPTION",
  projectionName: "merchant_order_exception_v1",
  storeLabel: stores[index]?.storeLabel,
  businessDate: "2026-08-12",
  projectedAt: "2026-08-12T16:30:00.000Z",
  freshnessStatus: "Stale",
  items: [
    {
      exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000901",
      orderReference: "018f0f58-767a-7f3b-a1d0-000000000902",
      orderNumber: null,
      kind: "PaidWithoutFulfillableOrder",
      severity: "Critical",
      status: "Open",
      providerState: "Unknown",
      compensationStatus: "Pending",
      sourceOwner: "Payment",
      createdAt: "2026-08-12T16:00:00.000Z",
      dueAt: "2026-08-12T16:15:00.000Z",
      ownerStatus: "Unassigned",
      sourceFinal: false,
    },
  ],
});
const headers = { "cache-control": "no-store" };

test("@production exception read recovers and clears old data on refresh denial", async ({
  page,
}) => {
  let response: "denied" | "stale" | "empty" = "denied";
  const mutations: string[] = [];
  page.on("request", (request) => {
    // WP-2423 Q18: the staff Session activity report is not a business mutation.
    if (request.method() !== "GET" && !request.url().endsWith("/merchant/session/activity"))
      mutations.push(request.method());
  });
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill(
      response === "denied"
        ? { status: 403, json: { error: "request_denied" }, headers }
        : { json: { ...view(0), ...(response === "empty" ? { items: [] } : {}) }, headers },
    ),
  );
  await page.goto("/operations/order-exceptions");
  await expect(page.getByRole("button", { name: "Retry loading exceptions" })).toBeVisible();
  response = "stale";
  await page.getByRole("button", { name: "Retry loading exceptions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Data may be out of date" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Paid without a fulfillable order", exact: true }),
  ).toBeVisible();
  for (const name of [
    "Acknowledge",
    "Assign",
    "Request owning-domain compensation / retry",
    "Resolve from final source evidence",
  ])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh" })).toBeFocused();
  response = "denied";
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Retry loading exceptions" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Paid without a fulfillable order", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry loading exceptions" })).toBeFocused();
  response = "empty";
  await page.getByRole("button", { name: "Retry loading exceptions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "No exceptions in this view" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Data may be out of date" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeFocused();
  expect(mutations).toEqual([]);
});

test("@production exception view follows the selected Store after an authorized switch", async ({
  page,
}) => {
  let selected = 0;
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(selected) },
      headers,
    }),
  );
  await page.route("**/merchant/store-context", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    expect(route.request().postDataJSON()).toEqual({
      targetStoreReference: stores[1]?.storeReference,
    });
    selected = 1;
    await route.fulfill({ json: { workspace: workspace(selected) }, headers });
  });
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      json: view(selected),
      headers,
    }),
  );
  await page.goto("/app");
  await page.getByLabel("Authorized Store").selectOption("018f8100-0000-7000-8000-000000000002");
  await page.getByRole("button", { name: "Switch Store", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Synthetic Store 2", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Order exceptions", exact: true }).click();
  await expect(page.getByText(/Synthetic Store 2 · Business date/)).toBeVisible();
  await expect(page.getByText(/Synthetic Store 1 · Business date/)).toHaveCount(0);
});

test("@production exception filters and clear remain keyboard operable", async ({ page }) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  const source = view(0);
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      json: {
        ...source,
        freshnessStatus: "Fresh",
        items: [
          source.items[0],
          {
            ...source.items[0],
            exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000903",
            orderReference: "018f0f58-767a-7f3b-a1d0-000000000904",
            orderNumber: null,
            kind: "CaptureDeadlineExceeded",
            dueAt: "2026-08-12T17:00:00.000Z",
          },
        ],
      },
      headers,
    }),
  );
  await page.goto("/operations/order-exceptions");

  const type = page.getByRole("combobox", { name: "Type", exact: true });
  await type.focus();
  // Options carry staff wording; "U" jumps to "Unpaid dine-in round".
  await type.press("U");
  await expect(type).toHaveValue("DiningUnpaidBatch");
  await expect(
    page.getByRole("heading", { name: "No exceptions match these filters", exact: true }),
  ).toBeVisible();
  const severity = page.getByRole("combobox", { name: "Severity", exact: true });
  await page.keyboard.press("Tab");
  await expect(severity).toBeFocused();
  await severity.press("H");
  await expect(severity).toHaveValue("High");
  const status = page.getByRole("combobox", { name: "Status", exact: true });
  await page.keyboard.press("Tab");
  await expect(status).toBeFocused();
  await status.press("A");
  await expect(status).toHaveValue("Acknowledged");
  const owner = page.getByRole("combobox", { name: "Owner", exact: true });
  await page.keyboard.press("Tab");
  await expect(owner).toBeFocused();
  await owner.press("A");
  await expect(owner).toHaveValue("Assigned");
  const provider = page.getByRole("combobox", { name: "Payment provider status", exact: true });
  await page.keyboard.press("Tab");
  await expect(provider).toBeFocused();
  await provider.press("U");
  await expect(provider).toHaveValue("Unknown");
  const overdue = page.getByRole("checkbox", { name: "Overdue only", exact: true });
  await page.keyboard.press("Tab");
  await expect(overdue).toBeFocused();
  await page.keyboard.press("Space");
  await expect(overdue).toBeChecked();
  await page.keyboard.press("Tab");
  const clear = page.getByRole("button", { name: "Clear filters", exact: true });
  await expect(clear).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(type).toHaveValue("All");
  await expect(severity).toHaveValue("All");
  await expect(status).toHaveValue("All");
  await expect(owner).toHaveValue("All");
  await expect(provider).toHaveValue("All");
  await expect(overdue).not.toBeChecked();
  await expect(
    page.getByRole("heading", { name: "Paid without a fulfillable order", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Capture deadline exceeded", exact: true }),
  ).toBeVisible();

  // Type and all remaining filters have been reset through keyboard interaction above.
  await overdue.press("Space");
  await expect(overdue).toBeChecked();
  await expect(
    page.getByRole("heading", { name: "Paid without a fulfillable order", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Capture deadline exceeded", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(clear).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(overdue).not.toBeChecked();
  await expect(
    page.getByRole("heading", { name: "Paid without a fulfillable order", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Capture deadline exceeded", exact: true }),
  ).toBeVisible();
});

test("@production workbench displays the full 500-row backlog", async ({ page }) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  const source = view(0);
  const items = Array.from({ length: 500 }, (_, index) => ({
    ...source.items[0],
    exceptionReference: "018f0f58-767a-7f3b-a1d0-" + index.toString(16).padStart(12, "0"),
  }));
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      json: { ...source, items },
      headers,
    }),
  );
  await page.goto("/operations/order-exceptions");
  await expect(
    page.getByRole("heading", { name: "Paid without a fulfillable order", exact: true }),
  ).toHaveCount(500);
  // WP-2423: times in words, never the machine instant (no Store zone here, so labelled UTC).
  await expect(page.getByText(/^Aug 12, 2026, 4:00\sPM UTC$/u).first()).toBeVisible();
  await expect(page.getByText(/due Aug 12, 2026, 4:15\sPM UTC/u).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Paid without a fulfillable order", exact: true }).last(),
  ).toBeAttached();
  await expect(page.getByText("Linked order · order number not shown").first()).toBeVisible();
  await expect(page.getByText("018f0f58-767a-7f3b-a1d0-000000000902", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Retry loading exceptions" })).toHaveCount(0);
  await page.getByRole("combobox").nth(1).selectOption("High");
  await expect(
    page.getByRole("heading", { name: "No exceptions match these filters" }),
  ).toBeVisible();
  await expect(page.getByText("No exception on this page matches the filters.")).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/exceptions-filter-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Paid without a fulfillable order", exact: true }),
  ).toHaveCount(500);
});

test("@production compensation acknowledgment remains keyboard operable and retries identical intent", async ({
  page,
  context,
}) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({ json: { ...view(0), freshnessStatus: "Fresh" }, headers }),
  );
  await page.route("**/merchant/operations/compensations/query", (route) =>
    route.fulfill({
      json: {
        caseVersion: 2,
        caseState: "Open",
        refund: {
          amountMinor: "1130",
          currencyCode: "CAD",
          confirmedAt: "2026-09-21T00:00:00.000Z",
        },
        acknowledgmentRecorded: false,
      },
      headers,
    }),
  );
  const bodies: string[] = [];
  await page.route("**/merchant/operations/compensations/reconcile", async (route) => {
    bodies.push(route.request().postData() ?? "");
    await route.fulfill(
      bodies.length === 1
        ? { status: 503, json: { error: "compensation_reconciliation_unknown" }, headers }
        : {
            status: 202,
            json: {
              status: "ReconciliationRecorded",
              replayed: true,
              reconciledAt: "2026-09-21T00:00:00.000Z",
            },
            headers,
          },
    );
  });
  await page.goto("/operations/order-exceptions");
  const review = page.getByRole("button", { name: "Review confirmed refund" });
  await review.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Confirmed refund: \$11.30/)).toBeVisible();
  const submit = page.getByRole("button", { name: "Record operations reconciliation" });
  await expect(submit).toBeDisabled();
  const confirmation = page.getByRole("checkbox", {
    name: "I have reviewed this confirmed refund and reconciled this case",
  });
  await confirmation.press("Space");
  await expect(confirmation).toBeChecked();
  await context.setOffline(true);
  await expect(submit).toBeDisabled();
  await expect(page.getByText("Offline — reconciliation is read-only.")).toBeVisible();
  await context.setOffline(false);
  await expect(submit).toBeEnabled();
  await submit.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Result unknown/)).toBeVisible();
  await expect(review).toBeDisabled();
  const retry = page.getByRole("button", { name: "Retry same acknowledgment" });
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({
      hasText:
        "Your check of the refund is recorded. Refresh the page to see whether the case is closed.",
    }),
  ).toBeFocused();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(JSON.parse(bodies[0] ?? "{}").expectedCaseVersion).toBe(2);
  await expect(page.getByText("Case: Open", { exact: true })).toBeVisible();
});

test("@production compensation unknown preserves focus moved during the request", async ({
  page,
}) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({ json: { ...view(0), freshnessStatus: "Fresh" }, headers }),
  );
  await page.route("**/merchant/operations/compensations/query", (route) =>
    route.fulfill({
      json: {
        caseVersion: 2,
        caseState: "Open",
        refund: {
          amountMinor: "1130",
          currencyCode: "CAD",
          confirmedAt: "2026-09-21T00:00:00.000Z",
        },
        acknowledgmentRecorded: false,
      },
      headers,
    }),
  );

  const writes: string[] = [];
  let releaseUnknown!: () => void;
  let notifyStarted!: () => void;
  const unknownBarrier = new Promise<void>((resolve) => {
    releaseUnknown = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  await page.route("**/merchant/operations/compensations/reconcile", async (route) => {
    writes.push(route.request().postData() ?? "");
    if (writes.length === 1) {
      notifyStarted();
      await unknownBarrier;
      await route.fulfill({
        status: 503,
        json: { error: "compensation_reconciliation_unknown" },
        headers,
      });
      return;
    }
    await route.fulfill({
      status: 202,
      json: {
        status: "ReconciliationRecorded",
        replayed: true,
        reconciledAt: "2026-09-21T00:00:00.000Z",
      },
      headers,
    });
  });

  await page.goto("/operations/order-exceptions");
  const review = page.getByRole("button", { name: "Review confirmed refund" });
  await review.focus();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("checkbox", {
    name: "I have reviewed this confirmed refund and reconciled this case",
  });
  await confirmation.press("Space");
  const submit = page.getByRole("button", { name: "Record operations reconciliation" });
  await submit.focus();
  await page.keyboard.press("Enter");
  await requestStarted;
  await expect(submit).toBeDisabled();

  const refresh = page.getByRole("button", { name: "Refresh" });
  await refresh.focus();
  releaseUnknown();
  await expect(page.getByText(/Result unknown/)).toBeVisible();
  await expect(refresh).toBeFocused();
  const retry = page.getByRole("button", { name: "Retry same acknowledgment" });
  await expect(retry).not.toBeFocused();
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({
      hasText:
        "Your check of the refund is recorded. Refresh the page to see whether the case is closed.",
    }),
  ).toBeFocused();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toBe(writes[0]);
});

test("@production unassociated reconciliation stays visible alongside a linked compensation case", async ({
  page,
}) => {
  let linked = false;
  const queries: unknown[] = [];
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      json: {
        ...view(0),
        freshnessStatus: "Fresh",
        items: [
          {
            ...view(0).items[0],
            exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000903",
            kind: "PaymentReconciliationDifference",
            orderReference: linked ? "018f0f58-767a-7f3b-a1d0-000000000904" : null,
            orderNumber: null,
            compensationStatus: "NotRequested",
          },
          ...view(0).items,
        ],
      },
      headers,
    }),
  );
  await page.route("**/merchant/operations/compensations/query", (route) => {
    queries.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        caseVersion: 2,
        caseState: "Open",
        refund: {
          amountMinor: "1130",
          currencyCode: "CAD",
          confirmedAt: "2026-09-21T00:00:00.000Z",
        },
        acknowledgmentRecorded: false,
      },
      headers,
    });
  });
  await page.goto("/operations/order-exceptions");
  const reconciliation = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Payment reconciliation difference", exact: true }),
  });
  const compensation = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Paid without a fulfillable order", exact: true }),
  });
  await expect(reconciliation.getByText("No matching order", { exact: true })).toBeVisible();
  await expect(reconciliation.getByRole("button", { name: "Review confirmed refund" })).toHaveCount(
    0,
  );
  await expect(compensation.getByRole("button", { name: "Review confirmed refund" })).toBeEnabled();
  expect(queries).toHaveLength(0);
  await compensation.getByRole("button", { name: "Review confirmed refund" }).click();
  await expect(compensation.getByText(/Confirmed refund: \$11.30/)).toBeVisible();
  expect(queries).toEqual([
    {
      orderReference: "018f0f58-767a-7f3b-a1d0-000000000902",
      caseReference: "018f0f58-767a-7f3b-a1d0-000000000901",
    },
  ]);
  linked = true;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(
    reconciliation.getByText("Linked order · order number not shown", { exact: true }),
  ).toBeVisible();
  await expect(
    reconciliation.getByText("018f0f58-767a-7f3b-a1d0-000000000904", { exact: true }),
  ).toHaveCount(0);
  await expect(reconciliation.getByText("No matching order", { exact: true })).toHaveCount(0);
  await expect(reconciliation.getByRole("button", { name: "Review confirmed refund" })).toHaveCount(
    0,
  );
  expect(queries).toHaveLength(1);
});

for (const failure of ["unknown", "conflict", "self", "denied"] as const) {
  test(`@production follow-up recovery ${failure} preserves safe operation identity`, async ({
    page,
    context,
  }) => {
    const writes: string[] = [];
    let queries = 0;
    await page.route("**/merchant/session", (route) =>
      route.fulfill({
        json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
        headers,
      }),
    );
    const source = view(0);
    await page.route("**/merchant/order-exceptions", (route) =>
      route.fulfill({
        json: {
          ...source,
          freshnessStatus: "Fresh",
          items: source.items.map((item) => ({
            ...item,
            kind: "PaymentReconciliationDifference",
            orderReference: null,
            orderNumber: null,
            compensationStatus: "NotRequested",
          })),
        },
        headers,
      }),
    );
    await page.route("**/merchant/operations/order-exceptions/follow-up-query", (route) => {
      queries++;
      return route.fulfill({
        json: {
          version: queries === 1 ? 1 : 2,
          followUpStatus: queries === 1 ? "Open" : "Assigned",
          acknowledged: false,
          assigned: queries > 1,
          updatedAt: "2026-08-12T16:30:00.000Z",
        },
        headers,
      });
    });
    await page.route("**/merchant/operations/order-exceptions/follow-up", (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
      writes.push(route.request().postData() ?? "");
      if (writes.length === 1)
        return failure === "unknown" || failure === "self"
          ? route.abort("failed")
          : route.fulfill({
              status: failure === "denied" ? 403 : 409,
              json: {
                error:
                  failure === "denied" ? "request_denied" : "reconciliation_follow_up_conflict",
              },
              headers,
            });
      return route.fulfill({
        status: 202,
        json: {
          status: "FollowUpRecorded",
          replayed: failure === "unknown" || failure === "self",
          version: failure === "unknown" || failure === "self" ? 2 : 3,
          followUpStatus: failure === "unknown" ? "Acknowledged" : "Assigned",
          updatedAt: "2026-08-12T16:31:00.000Z",
        },
        headers,
      });
    });
    await page.goto("/operations/order-exceptions");
    const region = page.locator('section[aria-label="Payment reconciliation follow-up"]');
    const review = region.getByRole("button", { name: "Review current follow-up" });
    const acknowledge = region.getByRole("button", {
      name: failure === "self" ? "Assign to me" : "Acknowledge payment difference",
      exact: true,
    });
    await review.click();
    await expect(region.getByText(/^Follow-up: not yet acknowledged · last changed/)).toBeVisible();
    await expect(region.getByRole("combobox", { name: "Assign to" })).toBeDisabled();
    await expect(region.getByRole("button", { name: "Assign payment difference" })).toBeDisabled();
    await context.setOffline(true);
    await expect(acknowledge).toBeDisabled();
    await expect(region.getByText("Offline — follow-up is read-only.")).toBeVisible();
    expect(writes).toHaveLength(0);
    await context.setOffline(false);
    await acknowledge.click();
    if (failure === "unknown" || failure === "self") {
      await expect(region.getByText(/Result unknown/)).toBeVisible();
      await expect(review).toBeDisabled();
      await expect(acknowledge).toBeDisabled();
      expect(queries).toBe(1);
      if (failure === "unknown") {
        await page.getByRole("combobox").nth(0).selectOption("DiningUnpaidBatch");
        await expect(
          page.getByRole("heading", { name: "No exceptions match these filters" }),
        ).toBeVisible();
        await expect(region).toBeHidden();
        const retry = region.locator("button").filter({ hasText: "Retry same follow-up" });
        await expect(retry).toBeAttached();
        await page.getByRole("button", { name: "Clear filters", exact: true }).click();
        await expect(region).toBeVisible();
        await expect(retry).toBeVisible();
      }
      await region.getByRole("button", { name: "Retry same follow-up" }).click();
    } else {
      await expect(
        region.getByText(
          failure === "denied" ? /Action was not accepted/ : /Someone else changed this follow-up/,
        ),
      ).toBeVisible();
      await expect(acknowledge).toHaveCount(0);
      await expect(region.getByRole("button", { name: "Retry same follow-up" })).toHaveCount(0);
      await review.click();
      await expect(region.getByText(/^Follow-up: assigned · last changed/)).toBeVisible();
      await acknowledge.click();
    }
    await expect(
      region.getByText(/Follow-up recorded.*stays open until it is resolved/),
    ).toBeVisible();
    await expect(review).toBeEnabled();
    expect(writes).toHaveLength(2);
    const first = JSON.parse(writes[0] ?? "{}");
    const second = JSON.parse(writes[1] ?? "{}");
    expect(first.expectedVersion).toBe(1);
    expect(first.action).toBe(failure === "self" ? "AssignSelf" : "Acknowledge");
    expect(first.assigneeReference).toBeNull();
    if (failure === "unknown" || failure === "self") expect(writes[1]).toBe(writes[0]);
    else {
      expect(second.expectedVersion).toBe(2);
      expect(second.operationReference).not.toBe(first.operationReference);
    }
  });
}

test("@production employee directory pagination clears stale choices on failure", async ({
  page,
}) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  const source = view(0);
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      json: {
        ...source,
        freshnessStatus: "Fresh",
        items: source.items.map((item) => ({
          ...item,
          kind: "PaymentReconciliationDifference",
          orderReference: null,
          orderNumber: null,
          compensationStatus: "NotRequested",
        })),
      },
      headers,
    }),
  );
  await page.route("**/merchant/operations/order-exceptions/follow-up-query", (route) =>
    route.fulfill({
      json: {
        version: 1,
        followUpStatus: "Open",
        acknowledged: false,
        assigned: false,
        updatedAt: "2026-08-12T16:30:00.000Z",
      },
      headers,
    }),
  );
  const actorReference = "01950000-0000-7000-8000-000000000010";
  let reads = 0,
    writes = 0;
  await page.route("**/merchant/operations/order-exceptions/follow-up-assignees", (route) => {
    reads++;
    expect(route.request().postDataJSON().afterActorReference).toBe(
      reads === 2 ? actorReference : null,
    );
    return reads === 1
      ? route.fulfill({
          json: {
            items: [{ actorReference, label: "Synthetic employee" }],
            nextAfterActorReference: actorReference,
          },
          headers,
        })
      : route.fulfill({
          status: 503,
          json: { error: "reconciliation_assignees_unavailable" },
          headers,
        });
  });
  await page.route("**/merchant/operations/order-exceptions/follow-up", (route) => {
    writes++;
    return route.abort();
  });
  await page.goto("/operations/order-exceptions");
  const region = page.getByRole("region", { name: "Payment reconciliation follow-up" });
  await region.getByRole("button", { name: "Review current follow-up" }).click();
  await region.getByRole("button", { name: "Load eligible employees" }).click();
  const selector = region.getByRole("combobox", { name: "Assign to" });
  await selector.selectOption(actorReference);
  await expect(region.getByRole("button", { name: "Assign payment difference" })).toBeEnabled();
  await region.getByRole("button", { name: "Next employee page" }).click();
  await expect(region.getByText(/Employee directory unavailable/)).toBeVisible();
  await expect(selector).toBeDisabled();
  await expect(selector).toHaveValue("");
  await expect(region.getByRole("option", { name: "Synthetic employee" })).toHaveCount(0);
  await expect(region.getByRole("button", { name: "Assign payment difference" })).toBeDisabled();
  await expect(region.getByRole("button", { name: "Assign to me", exact: true })).toBeEnabled();
  expect(writes).toBe(0);
});

test("@production WP-2423 a business day's totals difference resolved on re-check reads as such (v15 Oct 9)", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    // Reads that travel as POST (the follow-up query) are not changes.
    if (
      request.method() !== "GET" &&
      !request.url().endsWith("/merchant/session/activity") &&
      !request.url().endsWith("/follow-up-query")
    )
      writes.push(request.url());
  });
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          ...workspace(0),
          selectedScope: { ...stores[0], timeZone: "America/Toronto" },
        },
      },
      headers,
    }),
  );
  const base = view(0).items[0];
  const day = (n: number, resolvedAt: string | null) => ({
    ...base,
    exceptionReference: "018f0f58-767a-7f3b-a1d0-00000000092" + n,
    kind: "PaymentReconciliationDifference",
    severity: "High",
    orderReference: null,
    orderNumber: null,
    providerState: "Confirmed",
    compensationStatus: "NotRequested",
    status: resolvedAt === null ? "Open" : "Resolved",
    sourceFinal: resolvedAt !== null,
    reconciliation: {
      type: "BusinessDayTotals",
      businessDate: "2026-08-10",
      captured: { storeMinor: "5650", providerMinor: "5650" },
      refunded: { storeMinor: "0", providerMinor: "2260" },
      checkedAt: "2026-08-11T08:00:03.000Z",
      resolvedAt,
    },
  });
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      json: {
        ...view(0),
        freshnessStatus: "Fresh",
        items: [
          day(1, "2026-08-12T13:32:56.580Z"),
          {
            ...base,
            exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000923",
            kind: "PaymentReconciliationDifference",
            severity: "High",
            orderReference: null,
            orderNumber: null,
            providerState: "Confirmed",
            compensationStatus: "Completed",
            status: "Resolved",
            sourceFinal: true,
            reconciliation: { type: "UnmatchedCharge" },
          },
        ],
      },
      headers,
    }),
  );
  let followUpQueries = 0;
  await page.route("**/merchant/operations/order-exceptions/follow-up-query", (route) => {
    followUpQueries++;
    return route.fulfill({
      json: {
        version: 2,
        followUpStatus: "Acknowledged",
        acknowledged: true,
        assigned: false,
        updatedAt: "2026-08-11T15:00:00.000Z",
      },
      headers,
    });
  });
  await page.goto("/operations/order-exceptions");
  const card = page.locator("article").filter({
    has: page.getByRole("heading", {
      name: "Business day totals differ from the payment provider",
    }),
  });
  await expect(card.getByText("Resolved", { exact: true })).toBeVisible();
  await expect(card.getByText("Mon, Aug 10", { exact: true })).toBeVisible();
  await expect(
    card.getByText("Refunds: the payment provider has $22.60 more than the store."),
  ).toBeVisible();
  await expect(card.getByText(/^Resolved: the day was checked again/)).toBeVisible();
  for (const name of [
    "Review unmatched charge",
    "View charge details",
    "Review current follow-up",
    "Acknowledge payment difference",
    "Assign to me",
  ])
    await expect(card.getByRole("button", { name })).toHaveCount(0);
  await expect(card.getByText(/No matching order|No order is linked|Refresh the page/)).toHaveCount(
    0,
  );
  await card.getByRole("button", { name: "Show follow-up history" }).click();
  await expect(card.getByText(/^Last follow-up before it closed: acknowledged/)).toBeVisible();
  expect(followUpQueries).toBe(1);
  // The resolved unmatched charge keeps its charge and refund review, without live follow-up.
  const charge = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Charge that matches no order" }),
  });
  await expect(charge.getByRole("button", { name: "View charge details" })).toBeVisible();
  await expect(charge.getByRole("button", { name: "Review unmatched charge" })).toBeVisible();
  await expect(charge.getByRole("button", { name: "Acknowledge payment difference" })).toHaveCount(
    0,
  );
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await card.screenshot({ path: `test-results/exceptions-business-day-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await card.getByRole("link", { name: "Open Settlement for Mon, Aug 10" }).click();
  await expect(page).toHaveURL(
    /\/app\/operations\/payment-reconciliation\?businessDate=2026-08-10$/,
  );
  expect(writes).toEqual([]);
});

test("@production WP-2423 every open case first, resolved history a page at a time, confirmed refunds checked by day end", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && !request.url().endsWith("/merchant/session/activity"))
      writes.push(request.url());
  });
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          ...workspace(0),
          selectedScope: { ...stores[0], timeZone: "America/Toronto" },
        },
      },
      headers,
    }),
  );
  const base = view(0).items[0];
  const refunded = {
    ...base,
    exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000931",
    orderNumber: "41",
    providerState: "Confirmed",
    // Opened 12:00 local on Aug 12; the business day ends 04:00 local on Aug 13.
    createdAt: "2026-08-12T16:00:00.000Z",
    dueAt: "2026-08-13T08:00:00.000Z",
  };
  const unconfirmed = {
    ...base,
    exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000932",
    orderNumber: "42",
  };
  const resolved = (n: number) => ({
    ...base,
    exceptionReference: "018f0f58-767a-7f3b-a1d0-00000000090" + n,
    orderNumber: "3" + n,
    providerState: "Confirmed",
    compensationStatus: "Completed",
    status: "Resolved",
    sourceFinal: true,
  });
  let olderAttempts = 0;
  await page.route(/\/merchant\/order-exceptions(\?.*)?$/u, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("resolvedBefore");
    if (cursor === null)
      return route.fulfill({
        json: {
          ...view(0),
          freshnessStatus: "Fresh",
          olderResolvedBefore: "018f0f58-767a-7f3b-a1d0-000000000909",
          items: [refunded, unconfirmed, resolved(9)],
        },
        headers,
      });
    expect(cursor).toBe("018f0f58-767a-7f3b-a1d0-000000000909");
    if (olderAttempts++ === 0)
      return route.fulfill({ status: 503, json: { error: "unavailable" }, headers });
    return route.fulfill({
      json: {
        ...view(0),
        freshnessStatus: "Fresh",
        olderResolvedBefore: null,
        items: [refunded, unconfirmed, resolved(8)],
      },
      headers,
    });
  });
  await page.goto("/operations/order-exceptions");
  const card = (number: string) =>
    page.locator("article").filter({ has: page.getByText(`Order ${number}`, { exact: true }) });
  await expect(card("41").getByText(/^Refunded · check by Aug 13, 2026, 4:00\sAM$/u)).toBeVisible();
  await expect(
    card("41").getByText("Refunded — check by end of day", { exact: true }),
  ).toBeVisible();
  await expect(card("41").getByText("Critical", { exact: false })).toHaveCount(0);
  await expect(card("42").getByText(/^Critical · due Aug 12, 2026, 12:15\sPM$/u)).toBeVisible();
  await expect(card("42").getByText("Pending", { exact: true })).toBeVisible();
  // At 12:30 local only the unconfirmed case is overdue.
  await page.getByRole("checkbox", { name: "Overdue only" }).check();
  await expect(card("42")).toBeVisible();
  await expect(card("41")).toBeHidden();
  await page.getByRole("checkbox", { name: "Overdue only" }).uncheck();

  await expect(card("39")).toBeVisible();
  await expect(card("38")).toHaveCount(0);
  await page.getByRole("button", { name: "Show older resolved exceptions" }).click();
  await expect(
    page.getByText("Older resolved exceptions could not be loaded. Try again."),
  ).toBeVisible();
  await expect(card("39")).toBeVisible();
  await page.getByRole("button", { name: "Show older resolved exceptions" }).click();
  await expect(card("38")).toBeVisible();
  await expect(page.locator("article:visible")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Show older resolved exceptions" })).toHaveCount(0);
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await card("41").screenshot({ path: `test-results/exceptions-refund-check-${width}.png` });
  }
  // Refresh starts over from the newest resolved page.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(card("38")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show older resolved exceptions" })).toBeVisible();
  expect(writes).toEqual([]);
});
